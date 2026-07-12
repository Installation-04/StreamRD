# StreamRD backend
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npx prisma generate && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
# SQLite database lives on a volume mounted at /app/data
RUN mkdir -p /app/data
EXPOSE 4000
# Apply the schema on boot (idempotent), then start.
CMD ["sh", "-c", "npx prisma db push --skip-generate && node dist/index.js"]
