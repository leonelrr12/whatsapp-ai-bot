FROM node:20

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

# Create directories for auth and uploads
RUN mkdir -p /app/auth /app/uploads

EXPOSE 3000

CMD ["npm", "start"]
