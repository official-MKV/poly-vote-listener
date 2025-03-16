FROM node:18-alpine

# Install necessary packages for Prisma
RUN apk add --no-cache openssl

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy prisma schema
COPY prisma ./prisma/

# Copy source code and artifacts
COPY artifacts ./artifacts/
COPY listener.js ./

# Generate Prisma client without requiring migrations
RUN npx prisma generate

# Set environment variables (these will be overridden by secrets)
ENV NODE_ENV=production

# Run the listener
CMD ["node", "listener.js"]
