# Book Tower — AGENT1.md (기술 명세 & 구현 가이드)

---

## 1. 프로젝트 구조

```
Book-Tower/
├── www/
│   └── index.html          # 단일 파일 SPA (HTML + CSS + JS 모두 포함, ~3760 lines)
├── api/
│   ├── ranking.js          # Vercel Serverless API: GET/POST /api/ranking
│   └── reward.js           # Vercel Serverless API: POST /api/reward
├── android/                # Capacitor Android 빌드 디렉토리
├── public/                 # 정적 파일 (Vercel 배포용)
├── capacitor.config.json   # Capacitor 설정
├── vercel.json             # Vercel 라우팅 설정
├── AGENT.md                # 초기 요구사항 명세서
└── AGENT1.md               # 이 파일 (기술 구현 명세)
```

### 핵심 원칙: **단일 파일 아키텍처**

모든 UI, 스타일, 비즈니스 로직이 `www/index.html` 한 파일에 존재합니다.
외부 JS 파일이나 번들러가 없으므로, 모든 수정은 이 파일에 직접 이루어집니다.

---

## 2. 기술 스택

| 구분        | 기술                             | 버전          | 용도                         |
| ----------- | -------------------------------- | ------------- | ---------------------------- |
| 언어        | HTML5 + Vanilla JS + Vanilla CSS | -             | 전체 앱                      |
| 물리 엔진   | Matter.js                        | 0.19.0        | 2D 책 낙하 및 탑 시뮬레이션  |
| 3D 렌더링   | Three.js                         | r128          | 아바타 3D 뷰어               |
| 3D 카메라   | OrbitControls                    | r128          | 아바타 뷰어 마우스/터치 회전 |
| 폰트        | Pretendard                       | v1.3.9        | 전체 UI 타이포그래피         |
| 저장소      | localStorage                     | 브라우저 내장 | 사용자 데이터 영구 저장      |
| 백엔드      | Vercel Serverless Functions      | -             | 랭킹 API, 보상 API           |
| 모바일 빌드 | Capacitor                        | -             | Android APK 변환             |

---

## 3. 핵심 JavaScript 아키텍처

### 3.1 전역 상태 객체 (`state`)

```js
let state = {
  mode: 'idle',           // 'idle' | 'study' | 'rest'
  timeLeft: 0,            // 타이머 남은 초 (normal모드: 카운트업, pomo모드: 카운트다운)
  timerInterval: null,    // setInterval ID
  books: [],              // Matter.js Body 배열 (현재 물리 씬의 모든 오브젝트)
  isPaused: false,        // 일시정지 여부
  studyGoalMins: 30,      // 집중 목표 시간(분)
  restGoalMins: 5,        // 휴식 목표 시간(분)
  currentShape: 'book',   // 떨어지는 오브젝트 종류
  difficulty: 'easy',     // 'easy' | 'hard' (물리 마찰력 변동)
  warnings: 0,            // 부정행위 경고 횟수
  isWarningCooldown: false,
  currentSubject: '수학', // 현재 공부 중인 과목
  timerMode: 'normal',    // 'normal' | 'pomo'
  pomoRemainingRepeats: 1,
  manualZoomScale: 1,     // 핀치 줌 배율
  lastTickTime: 0,        // Date.now() 기반 타이머 드리프트 방지
}
```

### 3.2 localStorage 스키마 (`bookTowerv2`)

```js
{
  userId: "u_xxxxx_yyyyy",       // 고유 사용자 ID (최초 생성 후 고정)
  userName: "닉네임",             // 랭킹 표시 이름
  total: 0,                       // 전체 누적 초
  maxHeight: 0.0,                 // 최고 탑 높이 (m)
  vibrate: true,                  // 진동 설정
  dropInterval: 60,               // 책 떨어지는 주기 (초)
  subjectColors: {                // 과목 → 색상 매핑
    "수학": "#BBDEFB",
    "영어": "#C8E6C9"
  },
  equipped: {                     // 장착 아바타 아이템
    head: "h1", top: "t2", bottom: "b1", shoes: "s1"
  },
  unlockedItems: ["h1", "t1"],   // 해금된 아이템 ID 배열
  daily: {                        // 날짜 키 → 일별 데이터
    "2026. 5. 18.": {
      total: 3600,                // 당일 누적 초
      subjects: { "수학": 1800, "영어": 1800 },
      subjectList: ["수학", "영어"], // 당일 과목 순서 보존
      memo: "오늘도 화이팅"        // 달력 메모
    }
  }
}
```

> **날짜 키 형식**: `toLocaleDateString('ko-KR')` 결과값 (예: `"2026. 5. 18."`)
> 오전 5시 기준으로 날짜를 계산하는 `getOffsetDate()` 사용에 주의.

### 3.3 별도 localStorage 키

| 키                   | 내용                                           |
| -------------------- | ---------------------------------------------- |
| `bookPhysicsState` | 물리 오브젝트 직렬화 데이터 (새로고침 후 복구) |
| `bookSessionState` | 타이머 세션 상태 (새로고침 후 복구)            |
| `sensorGranted`    | 자이로 센서 권한 승인 여부                     |
| `tutorialSeen`     | 튜토리얼 표시 여부                             |
| `theme`            | 테마 설정 (`'dark'`                          |
| `customShape`      | 사용자 업로드 커스텀 오브젝트 이미지           |

---

## 4. 주요 함수 레퍼런스

### 4.1 데이터 계층

| 함수                      | 역할                                                         | 주의사항                                        |
| ------------------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| `getRecords()`          | localStorage에서 데이터 로드 + 스키마 마이그레이션 자동 처리 | **항상 이 함수로만 읽기.** 직접 파싱 금지 |
| `saveStudyRecord()`     | 1초마다 호출. 현재 과목 공부 시간 +1초 기록                  | `state.currentSubject` 기반                   |
| `savePhysicsState()`    | 물리 오브젝트를 JSON으로 직렬화하여 저장                     | 페이지 언로드 시 자동 호출됨                    |
| `restorePhysicsState()` | 저장된 오브젝트를 다시 Matter.js 씬에 추가                   | `initMatter()` 내에서 호출됨                  |
| `saveSessionState()`    | 타이머/모드 상태를 저장                                      | 매 tick마다 호출됨                              |
| `restoreSessionState()` | 페이지 로드 시 세션 복원                                     | DOMContentLoaded에서 호출됨                     |

### 4.2 과목 관리

| 함수                        | 역할                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `renderSubjectList()`     | `#subject-list-container`에 과목 카드 렌더링. ▶ 시작 버튼 + 🗑️ 삭제 버튼 포함 |
| `openAddSubjectModal()`   | 과목 추가 모달 열기 (입력 필드 초기화 포함)                                        |
| `addNewSubject()`         | 입력값 검증 후 today의 `subjectList`에 과목 추가, 색상 저장                      |
| `deleteSubject(sj)`       | 확인 다이얼로그 후 today의 `subjectList`에서 제거 + `subjectColors` 삭제       |
| `startSubjectTimer(subj)` | `state.currentSubject` 설정 후 타이머 탭으로 전환                                |
| `renderColorPalette()`    | `#color-palette`에 10개 색상 원 렌더링, 이미 사용 중인 색은 비활성화             |

### 4.3 타이머 & 물리

| 함수                         | 역할                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| `initMatter()`             | Matter.js 엔진 + 렌더러 초기화 (최초 1회만 실행)               |
| `startPomodoro()`          | 타이머 시작 (일반/뽀모도로 모드 분기)                          |
| `tick()`                   | 1초 tick. 공부 기록 저장, 오브젝트 소환, 뽀모도로 전환 처리    |
| `spawnObject()`            | 매 60초마다 책 오브젝트 낙하                                   |
| `spawnGachaItem()`         | 매 300초(5분)마다 아이템 박스 낙하 + 해금 처리                 |
| `calculateHeight()`        | 탑 높이 계산 + 배경 테마 업데이트 + 화면 밖 오브젝트 제거      |
| `autoCenterCamera()`       | 탑 높이에 따라 카메라 줌아웃/자동 팬                           |
| `handleOrientation(event)` | 자이로 센서 콜백. 5도 이상 → 흔들림, 15도 이상 → 붕괴 트리거 |
| `togglePause()`            | 물리 엔진(`runnerObj.enabled`) + 타이머 인터벌 동시 제어     |
| `quitSession()`            | 일시정지 상태로 유지 후 홈으로 이동, 랭킹 서버 동기화          |
| `resetSession()`           | 탑 + 타이머 완전 초기화 (공부 기록은 보존)                     |

### 4.4 물리 안정화 로직 (중요)

`initMatter()` 내 `beforeUpdate` 이벤트 핸들러에서 두 가지 안정화 처리:

1. **Velocity Damping**: 속도 < 0.05일 때 강제 0 처리 (미세 진동 제거)
2. **Freezing Logic**: `hasTouched`이고 속도 < 0.01이 30프레임 이상 지속되면 `setStatic(true)` 전환 (안정된 책은 완전 고정)
3. **깨우기**: 자이로 15도 이상 시 모든 `isStatic` 객체를 `setStatic(false)`로 해제

### 4.5 UI/네비게이션

| 함수                    | 역할                                                       |
| ----------------------- | ---------------------------------------------------------- |
| `switchTab(tabId)`    | 탭 전환 + 활성 탭 강조. 타이머 중 전환 시 경고             |
| `updateDashboard()`   | 통계 카드, 달력, 과목 목록 전체 갱신                       |
| `updateTheme(height)` | 탑 높이에 따라 배경 단계 변경 (4단계: 낮-하늘-우주-심우주) |

---

## 5. UI 뷰 구조

```
Body
├── #stage-container        배경 레이어 (z-index: -1)
│   ├── #bg-0 ~ #bg-3      4단계 그라데이션 배경 (opacity 전환)
│   └── #particles          별 파티클 (우주 단계에서 표시)
│
├── #home-view              홈 탭: 통계 + 달력 + 과목 목록
├── #timer-view             타이머 탭: Matter.js 캔버스 + HUD
├── #diy-view               아이템 탭: Three.js 3D 뷰어 + 도감
├── #ranking-view           랭킹 탭: 실시간 랭킹 목록
├── #settings-view          설정 탭: 닉네임/테마/진동/데이터 초기화
│
├── .bottom-nav             하단 고정 네비게이션 바
│
└── [Modal Overlays]
    ├── #fail-modal          탑 붕괴 시
    ├── #pomodoro-modal      타이머 시작 설정
    ├── #rest-modal          휴식 시간 (유튜브 임베드)
    ├── #login-modal         최초 닉네임 설정
    ├── #sensor-modal        자이로 센서 권한 요청
    ├── #warning-modal       부정행위 감지 경고
    ├── #add-subject-modal   과목 추가
    ├── #calendar-detail-modal  달력 날짜 클릭 상세
    └── #tutorial-modal      사용법 안내
```

---

## 6. 아바타 & 아이템 시스템

### 6.1 아이템 정의 (`AVATAR_ITEMS`)

4개 슬롯 × 5개 아이템 = 총 20개

| 슬롯   | ID    | 이름                                       | 등급                           |
| ------ | ----- | ------------------------------------------ | ------------------------------ |
| head   | h1~h5 | 야구모자/비니/밀짚모자/마법사모자/총장모자 | common/common/rare/epic/legend |
| top    | t1~t5 | 흰티/후드티/체크셔츠/가죽자켓/황금갑옷     | common/common/rare/epic/legend |
| bottom | b1~b5 | 청바지/트레이닝/반바지/정장바지/황금바지   | common/common/rare/epic/legend |
| shoes  | s1~s5 | 운동화/슬리퍼/구두/부츠/황금신발           | common/common/rare/epic/legend |

### 6.2 가챠 확률

| 등급   | 확률 |
| ------ | ---- |
| legend | 1%   |
| epic   | 4%   |
| rare   | 20%  |
| common | 75%  |

> **특이 케이스**: legend 등급 중 `h5`(총장 모자)는 추가로 1% 확률 (≒ 전체 0.01%)

### 6.3 Three.js 3D 뷰어

- **지연 초기화**: `diy` 탭 진입 시 `renderCollection()`이 호출될 때 `init3DViewer()` 실행
- **메모리 관리**: 아이템 교체 시 `disposeSlot3D(slot)` → `buildItemMeshes(slot, id)` 순서 필수
- **본 계층**: `Hips` → `Spine` → `Chest` → 팔/다리/머리 (`bones` 객체에 이름으로 접근)
- **함수 훅 패턴**: `renderCollection`, `equipItem`은 두 번째 `<script>` 블록에서 `window.xxx`로 래핑하여 Three.js 초기화 연동

---

## 7. 물리 오브젝트 종류

| 타입          | 크기          | 설명                                       |
| ------------- | ------------- | ------------------------------------------ |
| `book`      | 110~140 × 30 | 기본 책 (매 60초 낙하)                     |
| `gold-book` | 140 × 40     | 황금책 (특수)                              |
| `jokbo`     | 90 × 120     | 족보 (특수)                                |
| `advice`    | 100 × 60     | 선배님의 조언 (특수)                       |
| `notebook`  | 150 × 20     | 노트북 (특수)                              |
| `pad`       | 120 × 15     | 태블릿 (특수)                              |
| `summary`   | 80 × 100     | 요약본 (특수)                              |
| `coffee`    | 120 × 30     | 커피 박스 (특수)                           |
| `energy`    | 110 × 30     | 에너지드링크 (특수)                        |
| `vitamin`   | 100 × 30     | 비타민 (특수)                              |
| 아이템 박스   | 110~140 × 60 | 가챠 아이템 (매 300초 낙하)                |
| 방해물        | 다양          | 딴짓 감지 시 소환 (airplane/rocket/planet) |

---

## 8. 배경 테마 단계

| 단계 | 탑 높이 조건 | 배경                      |
| ---- | ------------ | ------------------------- |
| 0    | 0m ~ 5m      | 낮 (흰색/파랑 그라데이션) |
| 1    | 5m ~ 15m     | 하늘 (하늘색)             |
| 2    | 15m ~ 30m    | 저녁/우주 (다크 블루)     |
| 3    | 30m 이상     | 심우주 (검정) + 별 파티클 |

---

## 9. API 엔드포인트

### `GET /api/ranking`

랭킹 목록 반환 (점수 내림차순)

### `POST /api/ranking`

랭킹 등록/업데이트

```json
{
  "userId": "u_xxxxx",
  "username": "닉네임",
  "score": 12.3,
  "digest": "5bf6b008..."
}
```

### `GET /api/ranking?check=닉네임`

닉네임 중복 확인

### `POST /api/reward`

보상 아이템 지급 (오늘 5분 이상 집중 시)

```json
{
  "userId": "u_xxxxx",
  "studySeconds": 600,
  "digest": "5bf6b008..."
}
```

---

## 10. 주요 개발 패턴 & 주의사항

### ✅ 올바른 패턴

```js
// 데이터 읽기: 항상 getRecords() 사용
let data = getRecords();
const todayStr = getTodayStr();

// 데이터 쓰기: 항상 전체 객체를 다시 저장
data.someField = newValue;
localStorage.setItem('bookTowerv2', JSON.stringify(data));

// 과목 목록 수정 후 반드시 UI 갱신
renderSubjectList();
```

### ⚠️ 주의사항

1. **날짜 키 일관성**: `getTodayStr()`이 반환하는 `"2026. 5. 18."` 형식만 사용. `new Date().toLocaleDateString()` 직접 호출 금지 (오전 5시 기준 날짜 처리 누락됨)
2. **Matter.js 초기화**: `initMatter()`는 멱등성이 있어 중복 호출 안전. 하지만 `render` 객체가 null일 때만 실행됨
3. **Three.js 탭 전환**: `diy` 탭에서 다른 탭으로 갔다가 돌아올 때 캔버스 크기가 0으로 리셋될 수 있음. `switchTab('diy')`에서 `setTimeout(200ms)` 후 `renderer.setSize()` 재호출 필요
4. **`renderCollection` 함수 훅**: 두 번째 `<script>` 블록에서 `window.renderCollection`을 래핑하는 구조. 이 패턴을 유지하지 않으면 Three.js 뷰어가 초기화되지 않음
5. **물리 오브젝트 margin**: 모든 오브젝트는 `margin = 2`의 충돌 박스 여백을 가짐. 렌더링 스케일은 `cfg.width / (cfg.width + margin)` 보정 필요
6. **과목 이름의 특수문자**: `deleteSubject`, `startSubjectTimer` 등 inline onclick에서 `'` 문자를 `\'`로 이스케이프해야 함 (`safeId` 변수 패턴 사용)

---

## 11. 기능 추가 시 체크리스트

새 기능을 추가할 때 아래 항목을 확인하세요:

- [ ] `getRecords()` / `localStorage.setItem('bookTowerv2', ...)` 패턴 사용 여부
- [ ] `getTodayStr()` / `getOffsetDate()` 기반 날짜 처리 여부
- [ ] 새 localStorage 필드 추가 시 `getRecords()` 내 기본값 초기화 추가 여부
- [ ] UI 변경 후 `renderSubjectList()` / `updateDashboard()` 호출 여부
- [ ] 타이머 진행 중 탭 이동 차단 로직(`switchTab`) 영향 확인
- [ ] 다크모드/라이트모드 CSS 변수 지원 여부 (`var(--toss-card)` 등 사용)
- [ ] 모바일 터치 이벤트 지원 여부 (`pointer-events`, `touch-action` 등)
