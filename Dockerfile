# Multiplayer server only (the game itself is static and can live on Vercel or any static host).
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server/index.mjs"]
