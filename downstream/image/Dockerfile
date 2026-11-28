FROM node:24-bookworm-slim
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /opt/dataops-web
COPY sparkelf-dsh-plus-0.2.9-alpha.106.tgz /opt/dataops-web/plus.tgz
COPY dsh-plugin-backup /opt/extra/dsh-plugin-backup
RUN npm install --global @deepseek-ai/dsh@0.2.3-alpha.2 \
 && npm install --prefix /opt/plus-deps /opt/dataops-web/plus.tgz \
      dshmarket@1.84.1 \
      @sparkelf/dsh-web-runtime-compat@0.2.9-alpha.99 \
      yauzl@3.4.0 pend@1.2.0 --ignore-scripts --legacy-peer-deps
COPY profile /opt/dataops-web/profile
RUN rm -rf /opt/dataops-web/profile/node_modules/@sparkelf/dsh-plus /opt/dataops-web/profile/node_modules/@sparkelf/dsh-web-runtime-compat \
 && mkdir -p /opt/dataops-web/profile/node_modules/@sparkelf \
 && cp -a /opt/extra/dsh-plugin-backup /opt/dataops-web/profile/node_modules/@sparkelf/dsh-plugin-backup \
 && for rel in dshmarket yauzl pend; do [ -e "/opt/dataops-web/profile/node_modules/$rel" ] || cp -a "/opt/plus-deps/node_modules/$rel" "/opt/dataops-web/profile/node_modules/$rel"; done \
 && for rel in '@sparkelf/dsh-plus' '@sparkelf/dsh-web-runtime-compat'; do [ -e "/opt/dataops-web/profile/node_modules/$rel" ] || cp -a "/opt/plus-deps/node_modules/$rel" "/opt/dataops-web/profile/node_modules/$rel"; done
ENV DSH_HOME=/opt/dsh-home
RUN mkdir -p /opt/dsh-home/profiles && ln -s /opt/dataops-web/profile /opt/dsh-home/profiles/dataops-web
EXPOSE 3080
CMD ["dsh","--profile","dataops-web","--no-open"]
