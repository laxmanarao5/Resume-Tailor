FROM ubuntu:24.04

# Avoid interactive prompts during apt install
ENV DEBIAN_FRONTEND=noninteractive

# Install Node.js, certificates, and Tectonic shared libraries
RUN apt-get update && \
    apt-get install -y curl ca-certificates libfontconfig1 libgraphite2-3 libharfbuzz0b libharfbuzz-icu0 libssl3 && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean

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
