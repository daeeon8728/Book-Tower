import { createClient } from '@vercel/kv';

const kv = createClient({
  url: process.env.KV_REST_API_URL || 'https://communal-foxhound-121640.upstash.io',
  token: process.env.KV_REST_API_TOKEN || 'gQAAAAAAAdsoAAIgcDFmOTJmYzE4ZmZmZGU0OTk4OTliYzYzYzYyMzc4MmE1Yw'
});

export default async function handler(request, response) {
  // CORS 처리
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  // SERVER_DIGEST: 클라이언트가 임의로 점수를 조작해 전송하지 못하도록 하는 공유 시크릿
  // 실제 운영 시 반드시 Vercel 환경변수(SERVER_DIGEST)로 관리하세요.
  const EXPECTED_DIGEST = process.env.SERVER_DIGEST || '5bf6b008a9ec05f6870c476d10b53211797aa000f95aae344ae60f9b422286da';

  if (process.env.SERVER_ID) {
    console.log(`[${process.env.SERVER_ID}] API Called: ${request.method}`);
  }

  try {
    /* =============================================
       GET: 랭킹 조회
       쿼리스트링 ?check=<name> → 닉네임 중복 확인
    ============================================= */
    if (request.method === 'GET') {
      const { check } = request.query;

      // 닉네임 중복 체크: userId 기반 체계에서는 username:id 매핑으로 확인
      if (check) {
        const ownerId = await kv.get(`username:${check}:id`);
        if (ownerId) {
          return response.status(200).json({ exists: true });
        } else {
          return response.status(200).json({ exists: false });
        }
      }

      // 랭킹 조회: leaderboard sorted-set (member = userId, score = 현재 높이)
      const leaderboard = await kv.zrange('leaderboard', 0, 99, { rev: true, withScores: true });

      let formatted = [];
      if (Array.isArray(leaderboard) && leaderboard.length > 0) {
        if (typeof leaderboard[0] === 'object' && leaderboard[0] !== null) {
          // Upstash REST SDK: { member, score } 형태
          formatted = leaderboard.map((item, index) => ({
            id: index.toString(),
            userId: item.member,
            score: item.score
          }));
        } else {
          // Flat array: ['userId1', score1, 'userId2', score2, ...]
          for (let i = 0; i < leaderboard.length; i += 2) {
            formatted.push({
              id: Math.floor(i / 2).toString(),
              userId: leaderboard[i],
              score: Number(leaderboard[i + 1])
            });
          }
        }
      }

      if (formatted.length === 0) return response.status(200).json([]);

      // 유저별 닉네임 일괄 조회
      const userKeys = formatted.map(f => `user:${f.userId}:name`);
      const usernames = userKeys.length > 0 ? await kv.mget(...userKeys) : [];

      const finalData = formatted.map((f, i) => ({
        id: f.id,
        userId: f.userId,
        // 닉네임이 없으면 userId를 fallback으로 사용 (구버전 데이터 호환)
        username: usernames[i] || f.userId,
        score: f.score
      }));

      return response.status(200).json(JSON.parse(JSON.stringify(finalData)));

    /* =============================================
       POST: 현재 높이 업서트
       body: { userId, username, score, digest }
       - score: 유저가 '오늘은 여기까지' 버튼을 눌렀을 때의 현재 높이(m)
       - digest: 보안 시크릿 (서버와 공유)
    ============================================= */
    } else if (request.method === 'POST') {
      const { userId, username, score, digest } = request.body;

      // 필수 파라미터 검증
      if (!userId || !username || typeof score !== 'number') {
        return response.status(400).json({ error: '잘못된 요청입니다. userId, username, score(number)가 필요합니다.' });
      }

      // 점수 범위 검증: 물리적으로 불가능한 극단적 값 차단 (예: 999m 이상)
      if (score < 0 || score > 500) {
        return response.status(400).json({ error: '유효하지 않은 점수 범위입니다.' });
      }

      // 무결성 검증: digest가 서버 시크릿과 일치해야만 업데이트 허용
      if (digest !== EXPECTED_DIGEST) {
        console.warn(`[SECURITY] Digest mismatch from userId=${userId}`);
        return response.status(403).json({ error: '데이터 위변조가 감지되었습니다. (Digest 불일치)' });
      }

      // --- 닉네임 관리 (userId 기반) ---
      // userId는 절대 변하지 않는 고유 식별자.
      // 닉네임은 user:{userId}:name 에 저장, 변경 시 username:{name}:id 역방향 인덱스도 갱신.
      const currentName = await kv.get(`user:${userId}:name`);

      if (currentName !== username) {
        // 새 닉네임이 다른 userId에 의해 이미 사용 중인지 확인
        const nameTakenByUserId = await kv.get(`username:${username}:id`);
        if (nameTakenByUserId && nameTakenByUserId !== userId) {
          return response.status(400).json({ error: '이미 다른 사용자가 사용 중인 닉네임입니다.' });
        }

        // 기존 닉네임의 역방향 인덱스 삭제
        if (currentName) {
          await kv.del(`username:${currentName}:id`);
        }

        // 새 닉네임 저장
        await kv.set(`username:${username}:id`, userId);
        await kv.set(`user:${userId}:name`, username);

        console.log(`[RENAME] userId=${userId}: "${currentName}" → "${username}"`);
      }

      // --- 현재 높이를 랭킹에 덮어쓰기 (최고 높이가 아닌 현재 높이) ---
      // 항상 최신 값으로 갱신 (XX 옵션 없이 zadd하면 upsert 동작)
      await kv.zadd('leaderboard', { score: score, member: userId });

      console.log(`[RANK UPDATE] userId=${userId} (${username}): ${score}m`);
      return response.status(200).json({ success: true, score });

    } else {
      return response.status(405).json({ error: '지원하지 않는 메서드입니다.' });
    }
  } catch (error) {
    console.error('API Error:', error);
    return response.status(500).json({ error: '내부 서버 오류', detail: error.message });
  }
}
