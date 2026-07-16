# Stage 1: Node.js — decimal.js 설치 (npm cache volume 활용)
FROM node:24.18.0-alpine AS build
WORKDIR /app
RUN --mount=type=cache,target=/root/.npm \
    npm init -y && npm install decimal.js@10.4.3

# Stage 2: Nginx — 정적 파일 서빙
FROM nginx:latest

# nginx 설정 복사
COPY nginx.conf /etc/nginx/conf.d/default.conf

# decimal.js 라이브러리 복사 (CDN 대신 로컬 제공)
COPY --from=build /app/node_modules/decimal.js/decimal.js /usr/share/nginx/html/js/decimal.js

# 정적 파일 복사
COPY src/ /usr/share/nginx/html/

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
