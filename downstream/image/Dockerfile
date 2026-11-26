FROM node:24-bookworm-slim
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /opt/dataops-web
COPY profile /opt/dataops-web/profile
COPY sparkelf-dsh-plus-0.2.9-alpha.106.tgz /opt/dataops-web/plus.tgz
RUN npm install --global @deepseek-ai/dsh@0.2.3-alpha.2 \
 && npm install --prefix /opt/plus-deps /opt/dataops-web/plus.tgz --ignore-scripts \
 && mkdir -p /opt/dataops-web/profile/node_modules/@sparkelf && for d in /opt/plus-deps/node_modules/@sparkelf/*; do bn=$(basename "$d"); [ -e "/opt/dataops-web/profile/node_modules/@sparkelf/$bn" ] || cp -a "$d" "/opt/dataops-web/profile/node_modules/@sparkelf/$bn"; done
ENV DSH_HOME=/opt/dsh-home
RUN mkdir -p /opt/dsh-home/profiles && ln -s /opt/dataops-web/profile /opt/dsh-home/profiles/dataops-web
EXPOSE 3080
CMD ["dsh","--profile","dataops-web","--no-open"]
