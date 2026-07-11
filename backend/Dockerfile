FROM node:22-noble

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy all files
COPY . .

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
