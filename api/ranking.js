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

  // Vercel 환경 변수에서 로드, 없으면 기본값으로 폴백
  const EXPECTED_DIGEST = process.env.SERVER_DIGEST || '5bf6b008a9ec05f6870c476d10b53211797aa000f95aae344ae60f9b422286da';
  
  if (process.env.SERVER_ID) {
    console.log(`[${process.env.SERVER_ID}] API Called`);
  }

  try {
    if (request.method === 'GET') {
      // 닉네임 중복 체크 (FR-02)
      const { check } = request.query;
      if (check) {
        const nameTaken = await kv.get(`username:${check}:id`);
        const oldScore = await kv.zscore('leaderboard', check);
        if (nameTaken || oldScore !== null) {
          return response.status(200).json({ exists: true });
        } else {
          return response.status(200).json({ exists: false });
        }
      }

      // 기존 랭킹 조회 로직
      const leaderboard = await kv.zrange('leaderboard', 0, 99, { rev: true, withScores: true });
      
      let formatted = [];
      if (Array.isArray(leaderboard) && leaderboard.length > 0) {
        if (typeof leaderboard[0] === 'object' && leaderboard[0] !== null) {
          formatted = leaderboard.map((item, index) => ({
            id: index.toString(),
            userId: item.member,
            score: item.score
          }));
        } else {
          // Flat array 처리 (예: ['user_abc', score1, 'user_xyz', score2])
          for (let i = 0; i < leaderboard.length; i += 2) {
            formatted.push({
              id: Math.floor(i/2).toString(),
              userId: leaderboard[i],
              score: Number(leaderboard[i+1])
            });
          }
        }
      }

      if (formatted.length === 0) return response.status(200).json([]);

      const userKeys = formatted.map(f => `user:${f.userId}:name`);
      let usernames = [];
      if (userKeys.length > 0) {
        usernames = await kv.mget(...userKeys);
      }

      const finalData = formatted.map((f, i) => ({
        id: f.id,
        userId: f.userId,
        username: usernames[i] || f.userId, // 기존 데이터면 member 자체가 이름이므로 fallback 처리
        score: f.score
      }));
      
      return response.status(200).json(JSON.parse(JSON.stringify(finalData)));

    } else if (request.method === 'POST') {
      const { userId, username, score, digest } = request.body;
      
      if (!userId || !username || typeof score !== 'number') {
        return response.status(400).json({ error: '잘못된 요청입니다.' });
      }

      // 무결성 검증 (NFR-02)
      if (digest !== EXPECTED_DIGEST) {
        return response.status(403).json({ error: '데이터 위변조가 감지되었습니다. (Digest 불일치)' });
      }

      const currentName = await kv.get(`user:${userId}:name`);
      
      if (currentName !== username) {
        const nameTaken = await kv.get(`username:${username}:id`);
        const oldScore = await kv.zscore('leaderboard', username);
        
        if (nameTaken && nameTaken !== userId) {
          return response.status(400).json({ error: '이미 사용 중인 닉네임입니다.' });
        }
        
        if (!nameTaken && oldScore !== null && currentName !== null) {
          return response.status(400).json({ error: '이미 존재하는 과거 닉네임입니다.' });
        }

        if (currentName) {
          await kv.del(`username:${currentName}:id`);
        }
        await kv.set(`username:${username}:id`, userId);
        await kv.set(`user:${userId}:name`, username);

        // 구 버전 사용자의 마이그레이션 처리 (이름으로 기록된 score를 userId로 이전)
        if (!nameTaken && oldScore !== null && currentName === null) {
          await kv.zadd('leaderboard', { score: oldScore, member: userId });
          await kv.zrem('leaderboard', username);
        }
      }

      // 기존 점수 확인
      const currentScore = await kv.zscore('leaderboard', userId);
      
      // 기존 점수가 없거나 새로운 점수가 더 높을 경우에만 업데이트
      if (currentScore === null || score > currentScore) {
        await kv.zadd('leaderboard', { score: score, member: userId });
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
