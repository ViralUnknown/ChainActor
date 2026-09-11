# Specify the base Docker image
FROM apify/actor-node-playwright-chrome:22

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
