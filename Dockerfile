FROM node:20-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/tsconfig.json ./
RUN npm install
COPY server/src/ ./src/
COPY server/public/ ./public/
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips libvips-dev \
    libwebp-dev libwebp7 \
    libheif-dev libheif1 \
    libde265-0 libde265-dev \
    libx265-199 libx265-dev && rm -rf /var/lib/apt/lists/*
COPY server/package.json ./
RUN npm install --production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
EXPOSE 3000
ENV NODE_ENV=production
ENV PORT=3000
CMD ["node", "dist/index.js"]
