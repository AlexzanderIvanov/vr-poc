# syntax=docker/dockerfile:1.7

# ---- Build stage ----------------------------------------------------------
# node:24-alpine — Active LTS (Krypton). Digest pinned for reproducibility.
FROM node@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS build
WORKDIR /app

# Install deps with cache-friendly layer
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy sources and build
COPY . .
RUN npm run build

# ---- Runtime stage --------------------------------------------------------
# nginx:1.30-alpine — current stable line. Digest pinned for reproducibility.
FROM nginx@sha256:0272e4604ed93c1792f03695a033a6e8546840f86e0de20a884bb17d2c924883 AS runtime

# SPA-friendly nginx config (history fallback + long-cache for hashed assets,
# correct MIME for .glb/.gltf, gzip for text assets)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Static build output
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]