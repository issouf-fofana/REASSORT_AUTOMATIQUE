FROM nginx:alpine

# Servi séparément de /usr/share/nginx/html (le COPY . ci-dessous) : sinon nginx.conf finirait
# lui-même exposé publiquement comme un fichier statique quelconque du site.
COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY . /usr/share/nginx/html
# nginx.conf n'a pas sa place parmi les fichiers servis (copié une seconde fois par le COPY .
# ci-dessus avant d'avoir pu l'exclure autrement, faute de .dockerignore dans ce projet) : retiré
# explicitement du dossier public plutôt que de laisser la config nginx elle-même téléchargeable.
RUN rm -f /usr/share/nginx/html/nginx.conf

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
