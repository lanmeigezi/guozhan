FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY config/ ./config/
COPY src/ ./src/
COPY web/ ./web/
COPY cards/ ./cards/
COPY extensions/ ./extensions/
COPY docs/ ./docs/
COPY scripts/ ./scripts/
COPY tests/ ./tests/
COPY README.md RELEASE.md ./
ENV NODE_ENV=production CIV_HOST=0.0.0.0 CIV_PORT=8790
USER node
EXPOSE 8790
CMD ["node", "src/server/main.js"]
