# One image for the whole product: the API serves the built player site from the same address.
FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine AS server
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npx prisma generate && npx nest build && npm prune --omit=dev

FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app/server
ENV NODE_ENV=production WEB_DIST_DIR=/app/web/dist PORT=3100
COPY --from=server /app/server/node_modules ./node_modules
COPY --from=server /app/server/dist ./dist
COPY --from=server /app/server/prisma ./prisma
COPY --from=server /app/server/package.json ./
COPY --from=web /app/web/dist /app/web/dist
USER node
EXPOSE 3100
# Apply pending migrations, then start.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
