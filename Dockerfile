# ---- Base: shared Node.js layer ----
FROM node:24.18.0-alpine AS base
WORKDIR /app
COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --legacy-peer-deps

# ---- Dev: Vite HMR ----
FROM base AS dev
CMD ["npx", "vite", "--host"]

# ---- Build: production bundle ----
FROM base AS build
COPY . .
RUN npm run build

# ---- Prod: Nginx serve ----
FROM nginx:latest AS prod
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
