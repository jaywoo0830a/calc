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

# Explicitly vendor Three.js (UMD) + Mathbox2
RUN mkdir -p public/lib && \
    curl -sL -o public/lib/three.min.js https://cdn.jsdelivr.net/npm/three@0.137.0/build/three.min.js && \
    curl -sL -o public/lib/OrbitControls.js https://cdn.jsdelivr.net/npm/three@0.137.0/examples/js/controls/OrbitControls.js && \
    cp node_modules/mathbox/build/bundle/mathbox.min.js public/lib/ && \
    cp node_modules/mathbox/build/mathbox.css public/lib/

RUN npm run build

# ---- Prod: Nginx serve ----
FROM nginx:latest AS prod
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
