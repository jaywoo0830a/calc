# calc — 고정밀 사칙연산 계산기

소수점 32자리 정밀도를 지원하는 간단한 웹 계산기입니다. PHP BCMATH 방식처럼 32자리를 초과하는 소수부는 절사(버림) 처리됩니다.

## 기술 스택

- **decimal.js** — JavaScript 임의 정밀도 연산 라이브러리 (npm)
- **Node.js 24.18.0** — 빌드 스테이지 (decimal.js 설치)
- **Nginx (latest)** — 정적 파일 서빙
- **Docker** — 멀티 스테이지 컨테이너화

## 빠른 실행

### Docker Compose (권장)

```bash
# 빌드 & 실행 (npm 캐시 볼륨 자동 마운트)
docker compose up -d --build

# 중지
docker compose down
```

### Docker CLI

```bash
docker build -t calc .
docker run -d -p 8080:80 --name calc calc
```

브라우저에서 `http://localhost:8080` 접속.

### 로컬 개발

```bash
# src/ 폴더의 파일을 직접 열거나 간단한 HTTP 서버로 확인
cd src && python3 -m http.server 8000
```

## 프로젝트 구조

```
calc/
├── Dockerfile           # 멀티 스테이지 빌드 (node → nginx)
├── docker-compose.yml   # npm 캐시 볼륨 포함
├── nginx.conf           # Nginx 설정
├── .gitignore           # node_modules 제외
├── .dockerignore
├── README.md
└── src/
    ├── index.html       # 계산기 UI
    ├── style.css        # 스타일
    └── app.js           # 계산 로직 (decimal.js)
```

## 동작 방식

1. `decimal.js`의 정밀도를 32자리로 설정
2. 반올림 모드는 `ROUND_DOWN` (절사/버림)
3. 사칙연산(`+`, `−`, `×`, `÷`) 수행
4. 결과에서 불필요한 후행 0은 제거하여 표시
