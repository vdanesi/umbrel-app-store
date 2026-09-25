# Scontrinaio: immagine per umbrelOS (amd64 e arm64), costruita da GitHub Actions.
FROM node:20-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV PORT=8080 DATA_DIR=/data NODE_ENV=production
EXPOSE 8080
USER 1000:1000
CMD ["node", "server.js"]
