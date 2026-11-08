# Threadly - production image
FROM node:24-slim

# Always production, whatever NODE_ENV says in .env: Secure session cookies, CORS limited to
# ALLOWED_ORIGIN, HSTS, and the app refuses to start without a real SESSION_SECRET.
ENV NODE_ENV=production

WORKDIR /app

# Install only runtime dependencies (cached unless package files change)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Uploaded product pictures are kept here; docker-compose.yml mounts a volume on it so they survive updates.
RUN mkdir -p /app/uploads && chown node:node /app/uploads

# Run as the unprivileged "node" user that ships with the image
USER node

EXPOSE 3000

# Healthy when the shop answers on its own port. (Node has fetch built in, so no extra tool is needed.)
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/site-info').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
