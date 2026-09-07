FROM node:22-alpine
WORKDIR /app
aCOPY package.json ./
RUN npm install --omit=dev
COPY src ./src
EXPOSE 8080
CMD ["npm","start"]
