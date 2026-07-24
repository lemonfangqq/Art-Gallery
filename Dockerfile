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
RUN echo "deb http://deb.debian.org/debian bookworm-backports main" >> /etc/apt/sources.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
    libvips42 \
    libwebp7 \
    libjpeg62-turbo \
    libpng16-16 \
    libtiff6 \
    libexpat1 \
    libffi8 \
    ca-certificates \
    && apt-get install -y --no-install-recommends -t bookworm-backports \
    libheif1 libheif-plugin-libde265 \
    && ldconfig \
    && rm -rf /var/lib/apt/lists/*
COPY server/package.json ./
RUN npm install --production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
EXPOSE 3000
ENV NODE_ENV=production
ENV PORT=3000
CMD ["node", "dist/index.js"]
