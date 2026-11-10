FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/
COPY data/ ./data/
COPY samples/ ./samples/
RUN mkdir -p /app/var && chown -R node:node /app/var
ENV NODE_ENV=production
EXPOSE 10000
USER node
CMD ["node", "server.js"]
