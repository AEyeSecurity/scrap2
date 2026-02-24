FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

RUN mkdir -p /app/out /app/artifacts

ENV NODE_ENV=production
ENV SCRAPER_DEFAULT_HEADLESS=true

ENTRYPOINT ["node", "dist/index.js"]
CMD ["run"]
