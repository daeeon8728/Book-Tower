import { createClient } from '@vercel/kv';

const kv = createClient({
  url: process.env.KV_REST_API_URL || 'https://communal-foxhound-121640.upstash.io',
  token: process.env.KV_REST_API_TOKEN || 'gQAAAAAAAdsoAAIgcDFmOTJmYzE4ZmZmZGU0OTk4OTliYzYzYzYyMzc4MmE1Yw'
});

// 전체 아이템 풀 (클라이언트와 동일하게 유지)
const ALL_ITEMS = [
  { id: 'h1', slot: 'head', grade: 'common' },
  { id: 'h2', slot: 'head', grade: 'rare' },
  { id: 'h3', slot: 'head', grade: 'epic' },
  { id: 'h4', slot: 'head', grade: 'legend' },
  { id: 'h5', slot: 'head', grade: 'legend' },
  { id: 't1', slot: 'top',  grade: 'common' },
  { id: 't2', slot: 'top',  grade: 'rare' },
  { id: 't3', slot: 'top',  grade: 'epic' },
  { id: 't4', slot: 'top',  grade: 'legend' },
  { id: 'b1', slot: 'bottom', grade: 'common' },
  { id: 'b2', slot: 'bottom', grade: 'rare' },
  { id: 'b3', slot: 'bottom', grade: 'epic' },
  { id: 'b4', slot: 'bottom', grade: 'legend' },
  { id: 's1', slot: 'shoes', grade: 'common' },
  { id: 's2', slot: 'shoes', grade: 'rare' },
  { id: 's3', slot: 'shoes', grade: 'epic' },
  { id: 's4', slot: 'shoes', grade: 'legend' },
];

// 등급별 가중치 (집중 시간에 따라 달라짐)
function pickWeightedItem(studySeconds) {
  // 30분 이상이면 epic/legend 확률 상승
  let weights;
  if (studySeconds >= 1800) {
    weights = { common: 40, rare: 35, epic: 20, legend: 5 };
  } else if (studySeconds >= 600) {
    weights = { common: 55, rare: 30, epic: 12, legend: 3 };
  } else {
    weights = { common: 70, rare: 23, epic: 6, legend: 1 };
  }

  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  let rand = Math.random() * totalWeight;
  let pickedGrade = 'common';
  for (const [grade, w] of Object.entries(weights)) {
    rand -= w;
    if (rand <= 0) { pickedGrade = grade; break; }
  }

  const candidates = ALL_ITEMS.filter(i => i.grade === pickedGrade);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') return response.status(200).end();
  if (request.method !== 'POST') return response.status(405).json({ error: '지원하지 않는 메서드' });

  const EXPECTED_DIGEST = process.env.SERVER_DIGEST || '5bf6b008a9ec05f6870c476d10b53211797aa000f95aae344ae60f9b422286da';

  try {
    const { userId, studySeconds, digest } = request.body;

    if (!userId || typeof studySeconds !== 'number') {
      return response.status(400).json({ error: '잘못된 요청: userId, studySeconds 필요' });
    }

    // 1. Digest 검증 (위변조 차단)
    if (digest !== EXPECTED_DIGEST) {
      console.warn(`[REWARD SECURITY] Digest mismatch: userId=${userId}`);
      return response.status(403).json({ error: '보안 검증 실패 (Digest 불일치)' });
    }

    // 2. 최소 집중 시간 검증 (5분 = 300초)
    if (studySeconds < 300) {
      return response.status(400).json({
        error: '최소 5분 이상 집중해야 보상을 받을 수 있습니다.',
        required: 300,
        provided: studySeconds
      });
    }

    // 3. 중복 보상 방지: 마지막 보상 시각 확인 (1시간 쿨타임)
    const lastRewardKey = `reward:${userId}:lastTime`;
    const lastRewardTime = await kv.get(lastRewardKey);
    const now = Date.now();
    const COOLDOWN_MS = 60 * 60 * 1000; // 1시간

    if (lastRewardTime && (now - Number(lastRewardTime)) < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - (now - Number(lastRewardTime))) / 60000);
      return response.status(429).json({
        error: `보상 쿨타임 중입니다. ${remaining}분 후 다시 시도해주세요.`,
        cooldownMinutes: remaining
      });
    }

    // 4. 아이템 결정 (집중 시간 기반 가중치)
    const item = pickWeightedItem(studySeconds);

    // 5. 보상 기록 (쿨타임용 타임스탬프 저장)
    await kv.set(lastRewardKey, now.toString(), { ex: 3600 }); // 1시간 TTL

    console.log(`[REWARD] userId=${userId} earned itemId=${item.id} (grade=${item.grade}, studySec=${studySeconds})`);

    return response.status(200).json({
      success: true,
      item: { id: item.id, slot: item.slot, grade: item.grade }
    });

  } catch (error) {
    console.error('Reward API Error:', error);
    return response.status(500).json({ error: '내부 서버 오류', detail: error.message });
  }
}
