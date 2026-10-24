# Easy Reader

Transforme un texte en vidéo de lecture rapide : chaque mot s'affiche seul, au même endroit, aligné sur sa lettre pivot en rouge.

- Aperçu en direct dans la page, vitesse fixe ou accélération par paliers (250 → 300 → 375 → 500 → 750 mots/min).
- Export MP4 (H.264) dans le navigateur avec WebCodecs et [mp4-muxer](https://github.com/Vanilagy/mp4-muxer). Repli en temps réel avec MediaRecorder si WebCodecs n'est pas disponible.
- Formats 9:16, 4:5, 1:1 et 16:9 ; fonds crème, nuit et blanc ; quatre polices.

Tout se passe dans le navigateur : le texte n'est envoyé nulle part.

## Lancer en local

Site statique, sans étape de build :

```sh
python3 -m http.server 8000
```

puis ouvrir http://localhost:8000.

## Fichiers

- `rsvp.js` : découpage du texte, choix de la lettre pivot, chronologie, dessin d'une image.
- `video.js` : encodage de la vidéo.
- `app.js` : interface (texte, réglages, aperçu, export).
- `index.html`, `styles.css` : page.
