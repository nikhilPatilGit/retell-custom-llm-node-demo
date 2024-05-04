FROM node:18-alpine AS base
# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json to the working directory
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application code
COPY . .

# Set environment variables
ENV TWILIO_ACCOUNT_ID="ACf4ac03ab3333cd6d53962035dfb0b743" 
ENV TWILIO_AUTH_TOKEN="0ad3adc856860524079f10777b09a7ef"
ENV RETELL_API_KEY="25ef6a3c-3a77-4a03-9c5e-a19a64e2491b"
ENV OPENAI_APIKEY="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"

# Expose the port the app runs on
EXPOSE 8081

# Command to run the application
CMD ["npm", "run", "dev"]
