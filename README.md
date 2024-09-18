StickerImageBot
===============

Bot to export telegram stickers to images. [Here is a sample one to play with (Not sure it's running)](https://telegram.me/stickerset2packbot)

Send individual stickers or sticker links (something like `https://t.me/addstickers/AniColle`) to prepare a zip of sticker image file.

### Requirements

* Node.js v8.0.0^
* ImageMagick with webp support (Check with `identify -list format | grep -i 'webp'` on *nix systems)
* [lottieconv](https://crates.io/crates/lottieconv)

### Usage

1. git clone
2. Get a bot token from [@BotFather](https://telegram.me/BotFather)
3. Copy `config.js.example` to `config.js` and edit as your needs
4. `npm install && npm start`

### License

MIT
