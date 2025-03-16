FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy prisma schema
COPY prisma ./prisma/

# Generate Prisma client
RUN npx prisma generate

# Copy artifacts for contract ABIs
COPY artifacts ./artifacts/

# Copy the listener script and other necessary files
COPY listener.js ./
COPY .env.example ./.env

# Set environment variables
ENV NODE_ENV=production

# Run the listener
CMD ["node", "listener.js"]
