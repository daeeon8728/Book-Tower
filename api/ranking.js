const { kv } = require('@vercel/kv');

export default async function handler(request, response) {
  // CORS 처리
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  const EXPECTED_DIGEST = '5bf6b008a9ec05f6870c476d10b53211797aa000f95aae344ae60f9b422286da';

  try {
    if (request.method === 'GET') {
      // 닉네임 중복 체크 (FR-02)
      const { check } = request.query;
      if (check) {
        const score = await kv.zscore('leaderboard', check);
        // 존재하면 score는 숫자(또는 0), 없으면 null
        if (score !== null) {
          return response.status(200).json({ exists: true });
        } else {
          return response.status(200).json({ exists: false });
        }
      }

      // 기존 랭킹 조회 로직
      const leaderboard = await kv.zrange('leaderboard', 0, 99, { rev: true, withScores: true });
      
      const formatted = leaderboard.map((item, index) => ({
        id: index.toString(),
        name: item.member,
        score: item.score
      }));
      
      return response.status(200).json(formatted);

    } else if (request.method === 'POST') {
      const { name, score, digest } = request.body;
      
      if (!name || typeof score !== 'number') {
        return response.status(400).json({ error: '잘못된 요청입니다.' });
      }

      // 무결성 검증 (NFR-02)
      if (digest !== EXPECTED_DIGEST) {
        return response.status(403).json({ error: '데이터 위변조가 감지되었습니다. (Digest 불일치)' });
      }

      // 기존 점수 확인
      const currentScore = await kv.zscore('leaderboard', name);
      
      // 기존 점수가 없거나 새로운 점수가 더 높을 경우에만 업데이트
      if (currentScore === null || score > currentScore) {
        await kv.zadd('leaderboard', { score: score, member: name });
      }
      
      return response.status(200).json({ success: true });

    } else {
      return response.status(405).json({ error: '지원하지 않는 메서드입니다.' });
    }
  } catch (error) {
    console.error('API Error:', error);
    return response.status(500).json({ error: '내부 서버 오류' });
  }
}
