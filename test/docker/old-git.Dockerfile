FROM node:22-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends make gcc libc6-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://mirrors.edge.kernel.org/pub/software/scm/git/git-2.17.0.tar.gz | tar xz -C /tmp \
 && make -C /tmp/git-2.17.0 -j"$(nproc)" prefix=/usr/local NO_GETTEXT=1 NO_TCLTK=1 NO_OPENSSL=1 NO_CURL=1 NO_EXPAT=1 NO_PERL=1 NO_PYTHON=1 install \
 && rm -rf /tmp/git-2.17.0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
CMD ["sh", "-c", "git --version && npx vitest run"]
