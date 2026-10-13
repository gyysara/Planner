FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY public ./public
COPY assets ./assets
COPY scripts ./scripts
RUN mkdir -p /data && chown node:node /data
USER node
ENV DATA_DIR=/data PORT=3000
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
