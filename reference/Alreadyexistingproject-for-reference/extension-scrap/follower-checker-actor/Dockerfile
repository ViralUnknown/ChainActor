FROM apify/actor-node-playwright:20

USER root
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    && curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg] https://brave-browser-apt-release.s3.brave.com/ stable main" | tee /etc/apt/sources.list.d/brave-browser-release.list \
    && apt-get update \
    && apt-get install -y brave-browser \
    && rm -rf /var/lib/apt/lists/*

USER myuser

COPY --chown=myuser:myuser package*.json ./
RUN npm install --omit=dev

COPY --chown=myuser:myuser . ./

CMD ["npm", "start"]
