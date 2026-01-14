# Instructions to build the Docker image
# docker build -t y-redis .

# Run the worker as follows:
# docker run --env-file ./.env  y-redis npm run start:worker

# Run the server as follows:
# docker run -p 3002:3002 --env-file ./.env y-redis npm run start:server

# Use an official Node.js runtime as a parent image
# FROM node:20-alpine
FROM node:lts-alpine3.19

# Install glibc compatibility for alpine
# See more at https://wiki.alpinelinux.org/wiki/Running_glibc_programs
RUN apk add gcompat

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if available) to the working directory
COPY package*.json ./

# Install any dependencies
RUN npm install

# Bundle your app source inside the Docker image
COPY . .

# build files
RUN npm run dist

# Make port 3002 available to the world outside this container,
# assuming your app runs on port 3002
EXPOSE 3002

# Removed CMD instruction to allow dynamic command execution at runtime
CMD node ./server.js
