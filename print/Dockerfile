# NEO, hosted: the PDF printer. Headless Chromium and Paged.js behind one
# POST, deployed as its own Railway service with this folder as its root.
# docs/print-service.md has the steps.
#
#   docker build -t neo-print print/
#   docker run -p 8081:8081 -e NEO_PRINT_SECRET=... neo-print

# Playwright's image carries the Chromium that playwright-core 1.63 drives;
# the two versions must match, so bump them together.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js ./
COPY lib ./lib

ENV NODE_ENV=production \
    PORT=8081

# Chromium runs as the image's unprivileged user; nothing here needs root.
USER pwuser
EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8081)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
