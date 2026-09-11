FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache mysql-client \
  && addgroup -S nodeapp \
  && adduser -S nodeapp -G nodeapp
RUN mkdir -p /var/lib/elite-emporium/media /var/lib/elite-emporium/backups \
  && chown -R nodeapp:nodeapp /var/lib/elite-emporium
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package*.json ./
USER nodeapp
EXPOSE 4000
CMD ["node", "dist/src/server.js"]
