# 엔트리 브라우저 서버

엔트리 작품(엔트리 브라우저)이 실시간 변수 `REQ`에 주소를 적으면, 이 서버가 그 페이지를 가져와
글 위주의 작은 HTML로 줄인 뒤 `C1`~`C12`와 `RES`에 적어 돌려줍니다.

실시간 변수 접속 방식은 [qwert1566/entry-variable-api](https://github.com/qwert1566/entry-variable-api) (MIT)를 참고했습니다.

## 1. 작품 준비

1. `entry_browser.ent`를 엔트리 만들기 화면에서 "오프라인 작품 불러오기"로 연다.
2. 속성 탭 → 변수에서 `REQ`, `RES`, `C1`~`C12` 14개가 **실시간 변수**로 표시되는지 확인한다.
   일반 변수로 보이면 알려 주세요(파일 쪽을 고쳐야 합니다).
3. 작품을 저장한다. 주소 `playentry.org/project/<작품ID>`의 `<작품ID>`를 적어 둔다.

## 2. 내 컴퓨터에서 먼저 확인

```
npm install
ENTRY_ID=봇계정아이디 ENTRY_PW=비밀번호 PROJECT_ID=작품ID node server.js
```

`연결됨. 요청을 기다리는 중`이 뜨면 작품을 실행해서 홈의 "Example Domain"을 눌러 본다.
터미널에 `응답 https://example.com …`이 찍히고 작품에 페이지가 뜨면 성공.

## 3. 무료 호스팅에 올리기 (Render 기준)

1. 이 폴더를 GitHub 저장소로 올린다. **비밀번호는 코드에 적지 않는다.**
2. Render에서 New → Web Service → 저장소 선택. Build `npm install`, Start `npm start`, Free 플랜.
3. Environment에 `ENTRY_ID`, `ENTRY_PW`, `PROJECT_ID`를 넣는다.
4. 무료 플랜은 15분 동안 접속이 없으면 잠든다. UptimeRobot 같은 무료 모니터로
   서비스 주소(`https://<이름>.onrender.com/`)를 5분마다 호출하게 해 두면 깨어 있다.
   이 주소를 열면 연결 상태가 JSON으로 보인다.

## 환경 변수

| 이름 | 설명 |
|---|---|
| `ENTRY_ID`, `ENTRY_PW` | 봇 전용 엔트리 계정. 작품 올리는 계정과 따로 쓰기를 권장 |
| `PROJECT_ID` | 작품 ID |
| `ALLOW_HOSTS` | (선택) 허용할 사이트만 쉼표로. 예: `wikipedia.org,example.com`. 비우면 모두 허용 |
| `CSS` | (선택) `0`으로 두면 CSS 없이 글만 보냄. 기본은 CSS 적용 |
| `CF_ACCOUNT_ID`, `CF_API_TOKEN` | (선택) Cloudflare Browser Run. 넣으면 자바스크립트 실행이 끝난 페이지를 받아 온다. 토큰 권한은 `Browser Run - Edit`. 무료 한도(하루 10분, 10초에 1번)를 넘으면 자동으로 기존 방식으로 처리 |
| `CHUNK_SIZE` | (선택) 변수 한 칸 글자 수. 기본 2500. 페이지가 중간에 깨지면 1000으로 낮춰 본다 |

## 두 가지 방식

1. **그리기 목록(기본, Cloudflare 키가 있을 때)**: 렌더링 서비스의 크롬이 페이지를 실제로 그린 뒤 `extract.js`가 상자와 글자의 좌표를 뽑아 보낸다. 엔트리는 그대로 칠한다. 배치가 실제 브라우저와 같다.
2. **HTML 해석(대체)**: 키가 없거나, 한도를 넘었거나, 사이트가 스크립트 주입을 막으면 예전 방식대로 줄인 HTML과 CSS를 보내고 엔트리가 직접 해석한다.

같은 주소는 10분 동안 결과를 기억해 재사용한다.

## 동작과 한계

- 페이지의 CSS(`<style>`과 외부 스타일시트 최대 8개)를 서버에서 계산해, 실제 쓰인 스타일만 작은 `<style>`과 class로 붙여 보낸다.
- 렌더러가 아는 속성만 남긴다(색, 배경색, 여백, 테두리, 글자 크기·굵기, 정렬, 너비, flex 등). `position`, `float`, 배경 이미지, 애니메이션은 버린다.
- `display:none`, `position:absolute/fixed`인 요소와 스크립트, 이미지, 입력 양식은 버린다.
- 한 페이지는 노드 약 420개, 글자 약 3만 자에서 자른다.
- 내부망 주소(localhost, 사설 IP)와 http/https가 아닌 주소는 거부한다.
- 요청은 한 번에 하나씩 처리하고, 같은 사용자의 0.8초 내 연타는 무시한다.
