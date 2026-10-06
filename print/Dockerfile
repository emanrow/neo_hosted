# neo-print: the hosted edition's PDF printer. Debian's Chromium and the three
# npm packages print/server.js needs; nothing of the app itself. Railway
# builds this from the repository with the service's Root Directory set to
# `print`, so the build context is this folder.
#
#   docker build -t neo-print print
#   docker run -p 8081:8080 -e NEO_PRINT_SECRET=... neo-print

FROM node:22-bookworm-slim

# Chromium and the fonts a book falls back on when its own face lacks a glyph
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-dejavu-core fonts-noto-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js book.js book.css hyphenate.js ./

ENV NODE_ENV=production \
    PORT=8080 \
    CHROMIUM_PATH=/usr/bin/chromium

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
