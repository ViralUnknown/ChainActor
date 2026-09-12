# Specify base Docker image
FROM apify/actor-node-playwright-chrome:22

# Install Brave Browser & Brave Shields dependencies
USER root
RUN apt-get update && apt-get install -y curl apt-transport-https gnupg \
    && curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg] https://brave-browser-apt-release.s3.brave.com/ stable main" | tee /etc/apt/sources.list.d/brave-browser-release.list \
    && apt-get update && apt-get install -y brave-browser \
    && rm -rf /var/lib/apt/lists/*
USER myuser

# Copy just package.json and package-lock.json
COPY --chown=myuser:myuser package*.json ./

# Install NPM packages
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version

# Copy remaining source files
COPY --chown=myuser:myuser . ./

CMD npm start
