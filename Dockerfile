# NEO, hosted. The desktop app's own page and scripts served by web/server.js,
# with each writer's library as plain files on a mounted volume (NEO_DATA_DIR).
#
#   docker build -t neo-hosted .
#   docker run -p 8080:8080 -v neo-data:/data -e NEO_SESSION_SECRET=... -e NEO_SIGNUP=open neo-hosted

FROM node:22-slim

WORKDIR /app

# runtime dependencies only: the spellcheck engine, its dictionaries, and JSZip
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --omit=dev --no-audit --no-fund

# the desktop app's shared files, served as they are
COPY package.json index.html app.js styles.css covers.js i18n.js spell-ro.js art.js import-parse.js ./
COPY fonts ./fonts
COPY build/icon.png ./build/icon.png
COPY locales ./locales
COPY web ./web

ENV NODE_ENV=production \
    PORT=8080 \
    NEO_DATA_DIR=/data

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "web/server.js"]
