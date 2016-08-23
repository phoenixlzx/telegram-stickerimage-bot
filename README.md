StickerImageBot
===============

Bot to export telegram stickers to images.

**Due to the limitation and lack of Telegram API/Documentation, You MUST send all stickers you want to export.**

### Requirements

* Node.js v4.0.0^
* ImageMagick with webp support (Check with `identify -list format | grep -i 'webp'` on *nix systems)

### Usage

1. git clone
2. Get a bot token from [@BotFather](https://telegram.me/BotFather)
3. Copy `config.js.example` to `config.js` and edit as your needs
4. `npm install && npm start`

### License

MIT
