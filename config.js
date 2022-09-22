module.exports = {
    // telegram bot token and username, get from @BotFather
    token: '5671151663:AAGmuLGCFvGEsguE8dLzYxnDkGOIdEisU6k',
    username: 'VOID4STICKERSBOT',

    // imagemagick convert path, defaults to 'convert'
    im_convert_path: 'convert',

    // max images allowed in one pack
    maximages: 180,
    // file storage path
    file_storage: './storage',

    // recognized sticker sources
    sticker_sources: [
        'https://t.me/addstickers/',
        'https://telegram.me/addstickers/'
    ],
    // use language
    default_lang: 'en',
    available_lang: {
        'en': ['English', 'English'],
        'de': ['German', 'Deutsch'],
        'zh-hans': ['简体中文', '中国'],
        'zh-hant': ['正體中文', '中國'],
        'pt': ['Português (Portugal)']
    }
};

