#!/bin/env node
'use strict';

const config = require('./config.js');

const fs = require('fs-extra');
const path = require('path');

const Telegraf = require('telegraf');
const Extra = require('telegraf/extra');
const commandParts = require('telegraf-command-parts');
const im = require('imagemagick');
const JSZip = require("jszip");
const async = require('async');
const request = require('request');

const bot = new Telegraf(config.token, {username: config.username});

bot.use(commandParts());
im.convert.path = config.im_convert_path;

let messages = {};
loadLang();

let ramdb = {};
// check storage path
let fspath = path.resolve(config.file_storage);
fs.stat(fspath, function(err, stats) {
    if (err && err.code === 'ENOENT') {
        logger('INTERNAL', 'info', messages[config.default_lang].app.storagepathnotexist);
        fs.mkdirpSync(fspath);
    }
});

bot.catch(function (err) {
    logger('INTERNAL', 'error', err);
});

bot.command('lang', function (ctx) {
    i18nHandler(ctx);
});

bot.command('newpack', function (ctx) {
    newPackHandler(ctx);
});

bot.command('addset', function (ctx) {
    let chatId = ctx.message.chat.id;
    stickerSetHandler(ctx, function (setInfo) {

    })
});

bot.command('finish', function (ctx) {
    let chatId = ctx.message.chat.id;
    if (ramdb[chatId] && ramdb[chatId].islocked) {
        return bot.sendMessage(chatId, messages[ctx.state.lang | config.default_lang].msg.tasklocked);
    }
    let r = new RegExp(/\s?(png)?\s?(\d+)?/i);
    let match = r.exec(ctx.state.command.args);
    let imopts = {
        format: match[1],
        width: parseInt(match[2])
    };
    if (ramdb[chatId] && ramdb[chatId].files.length > 0) {
        finishHandler(ctx, imopts);
    } else {
        ctx.reply(messages[ctx.state.lang | config.default_lang].msg.nosticker);
    }
});

bot.command('cancel', function (ctx) {
    cancellationHandler(ctx);
});

bot.on('message', function (ctx) {
    generalMsgHandler(ctx);
});

bot.startPolling();

function errMsgHandler(ctx, err) {
    let chatId = ctx.message.chat.id;
    if (err) {
        ctx.reply(messages[ctx.state.lang | config.default_lang].msg.errmsg
            .replace('%errcode%', err.code)
            .replace('%errbody%', err.response.body));
    } else {
        ctx.reply(messages[ctx.state.lang | config.default_lang].msg.error);
    }
    return cleanup(chatId);
}
function newPackHandler (ctx) {
    let chatId = ctx.message.chat.id;
    if (ramdb[chatId] && ramdb[chatId].islocked) {
        return ctx.reply(messages[ctx.state.lang | config.default_lang].msg.tasklocked);
    }
    if (ramdb[chatId] && ramdb[chatId].files.length > 0) {
        return ctx.reply(messages[ctx.state.lang | config.default_lang].msg.taskexist);
    }
    ramdb[chatId] = {
        start: ctx.message.date,
        files: [],
        srcimg: [],
        destimg: [],
        islocked: false
    };
    logger(chatId, 'info', 'Started a new pack task.');
    return ctx.reply(messages[ctx.state.lang | config.default_lang].msg.newpack.replace('%max%', config.maximages));
}

function finishHandler (ctx, imopts) {
    let chatId = ctx.message.chat.id;
    logger(chatId, 'info', 'Starting pack task...');
    ramdb[chatId].islocked = true;
    let fpath = {
        packpath: config.file_storage + '/' + chatId
    };
    fpath['srcpath'] = fpath.packpath + '/src/';
    fpath['imgpath'] = fpath.packpath + '/img/';
    fs.mkdirpSync(path.resolve(fpath.packpath));
    fs.mkdirpSync(path.resolve(fpath.srcpath));
    fs.mkdirpSync(path.resolve(fpath.imgpath));
    async.series([
            function (cb) {
                downloadHanlder(ctx, fpath, function (err) {
                    cb(err);
                });
            },
            function (cb) {
                convertHandler(ctx, fpath, imopts, function (err) {
                    cb(err);
                })
            },
            function (cb) {
                zipHandler(ctx, function (err, zip) {
                    cb(err, zip);
                });
            }],
        function (err, res) {
            if (err) {
                errMsgHandler(ctx, err);
            }
            ctx.reply(messages[ctx.state.lang | config.default_lang].msg.sending);
            ctx.telegram.sendDocument(ctx.from.id, {
                source: res[2],
                filename: 'stickers_' + chatId + '.zip'
            }).catch(function(err){ errMsgHandler(ctx, err) });

            logger(chatId, 'info', 'Sending zip file...');
            cleanup(chatId);
            logger(chatId, 'info', 'Task finished.');
        }
    );
}

function cancellationHandler (ctx) {
    let chatId = ctx.message.chat.id;
    if (!ramdb[chatId]) {
        return ctx.reply(messages[ctx.state.lang | config.default_lang].msg.notask);
    }
    delete ramdb[chatId];
    cleanup(chatId);
    logger(chatId, 'info', 'Task Cancelled.');
    return ctx.reply(messages[ctx.state.lang | config.default_lang].msg.taskcancelled);
}

function generalMsgHandler (ctx) {
    let chatId = ctx.message.chat.id;
    if (ctx.chat.type !== 'private') return; // do not reply to group or channels ( unless mentioned? #TODO
    if (ramdb[chatId] && !ramdb[chatId].islocked) {
        if (ctx.message.sticker) {
            addSticker(ctx);
        }
        if (ctx.message.entities) {
            // try to add sets of stickers
            ctx.message.entities.forEach(function (e) {
                if (e.type === 'url') {
                    let url = ctx.message.text.slice(e.offset, e.offset + e.length);
                    if (url.startsWith('https://t.me/addstickers/') &&
                        url.length > 25)
                    stickerSetHandler(ctx, path.basename(url));
                }
            });
        }
    } else {
        ctx.reply((ramdb[chatId] && ramdb[chatId].islocked) ?
            messages[ctx.state.lang | config.default_lang].msg.tasklocked :
            messages[ctx.state.lang | config.default_lang].msg.start);
    }
}

function i18nHandler (ctx) {
    let chatId = ctx.message.chat.id,
        chosen_lang = ctx.state.command.args.replace(/\s+/g, ''); // strip spaces
    if (config.available_lang.hasOwnProperty(chosen_lang)) {
        ctx.state.lang = chosen_lang;
        logger(chatId, 'info', 'Changing language to: ' + chosen_lang);
        return ctx.reply(messages[ctx.state.lang | config.default_lang].msg.language_change)
    }
    let message = messages[ctx.state.lang | config.default_lang].msg.language_available,
        languages_names = '';
    for (let k in config.available_lang){
        if (config.available_lang.hasOwnProperty(k)) {
            languages_names += '\n' + '[' + k + '] ' + config.available_lang[k].join(' / ')
        }
    }
    return ctx.reply(message.replace('%languages%', languages_names));
}

function downloadHanlder (ctx, fpath, callback) {
    let chatId = ctx.message.chat.id;
    logger(chatId, 'info', 'Downloading files...');
    ctx.reply(messages[ctx.state.lang | config.default_lang].msg.downloading);
    async.eachSeries(ramdb[chatId].files, function (fileId, cb) {
        bot.telegram.getFileLink(fileId)
            .then(function(url) {
                let destFile = fpath.srcpath + path.basename(url);
                download(url, destFile, function (err) {
                    if (err) {
                        logger(chatId, 'error', 'Downloading file [' + fileId + '] from ' + url);
                        return cb(err);
                    }
                    if (destFile && destFile.indexOf('.') === -1) {
                        let new_dest = destFile + '.webp';
                        fs.renameSync(destFile, new_dest);
                        destFile = new_dest;
                    }
                    logger(chatId, 'info', 'File ' + fileId + ' saved to disk.');
                    ramdb[chatId].srcimg.push(destFile);
                    cb();
                });
            });
    }, function (err) {
        callback(err);
    });
}

function convertHandler (ctx, fpath, imopts, callback) {
    let chatId = ctx.message.chat.id;
    let width = imopts.width;
    let format = imopts.format;
    logger(chatId, 'info', 'Converting images...');
    ctx.reply(messages[ctx.state.lang | config.default_lang].msg.converting);
    async.eachSeries(ramdb[chatId].srcimg, function (src, cb) {
        let imarg = [src];
        let destimg = path.resolve(fpath.imgpath + '/' + path.basename(src, 'webp') + 'jpg');
        if (width && width < 512) {
            imarg.push('-resize', width + 'x' + width);
        }
        if (format === 'png') {
            destimg = path.resolve(fpath.imgpath + '/' + path.basename(src, 'webp') + 'png');
            imarg.push(destimg);
        } else {
            // use -flatten to add white background to jpg files
            imarg.push('-flatten', destimg)
        }
        logger(chatId, 'info', 'Convert: ' + im.convert.path + ' ' + imarg.join(' '));
        im.convert(imarg, function (err, stdout) {
            ramdb[chatId].destimg.push(destimg);
            cb(err);
        });
    }, function(err) {
        callback(err);
    });
}

function zipHandler (ctx, callback) {
    let chatId = ctx.message.chat.id;
    ctx.reply(messages[ctx.state.lang | config.default_lang].msg.packaging);
    logger(chatId, 'info', 'Adding files to ZIP file...');
    let zip = new JSZip();
    ramdb[chatId].srcimg.forEach(function (src) {
        let fname = chatId + '/src/' + path.basename(src);
        logger(chatId, 'info', 'Adding file ' + fname);
        zip.file(fname, fs.readFileSync(path.resolve(src)));
    });
    ramdb[chatId].destimg.forEach(function (dest) {
        let fname = chatId + '/img/' + path.basename(dest);
        logger(chatId, 'info', 'Adding file ' + fname);
        zip.file(fname, fs.readFileSync(path.resolve(dest)));
    });
    logger(chatId, 'info', 'Packaging files...');
    zip.generateAsync({
        compression: 'DEFLATE',
        type: 'nodebuffer',
        comment: 'Created by github.com/phoenixlzx/telegram-stickerimage-bot',
        platform: process.platform
    })
        .then(function (content) {
            callback(null, content);
        });
}

function stickerSetHandler (ctx, setName) {
    let chatId = ctx.message.chat.id;
    ctx.reply(messages[ctx.state.lang | config.default_lang].msg.get_set_info);
    bot.telegram.getStickerSet(setName)
        .then(function (set) {
            if (ramdb[chatId].files.length + set.stickers.length >= config.maximages) {
                return ctx.reply(messages[ctx.state.lang | config.default_lang].msg.taskfull);
            }
            logger(chatId, 'info', 'Adding Sticker Set: ' + setName);
            addSet(ctx, set);
        });
}

function addSticker(ctx) {
    let chatId = ctx.message.chat.id;
    if (ramdb[chatId].files.indexOf(ctx.message.sticker.file_id) !== -1) {
        return ctx.reply(messages[ctx.state.lang | config.default_lang].msg.duplicated_sticker, Extra.inReplyTo(ctx.message.message_id));
    }
    if (ramdb[chatId].files.length >= config.maximages) {
        return ctx.reply(messages[ctx.state.lang | config.default_lang].msg.taskfull);
    }
    ramdb[chatId].files.push(ctx.message.sticker.file_id);
    let remain = config.maximages - ramdb[chatId].files.length;
    ctx.reply(remain === 0 ?
        messages[ctx.state.lang | config.default_lang].msg.taskfull :
        messages[ctx.state.lang | config.default_lang].msg.saved.replace('%remain%', remain));
}

function addSet (ctx, set) {
    let chatId = ctx.message.chat.id;
    let originCount = ramdb[chatId].files.length;
    set.stickers.forEach(function (s) {
        if (ramdb[chatId].files.indexOf(s.file_id) === -1) {
            ramdb[chatId].files.push(s.file_id);
        }
    });
    ctx.reply(messages[ctx.state.lang | config.default_lang].msg.set_added_count
        .replace('%sticker_count%', ramdb[chatId].files.length - originCount));
}

function download (url, dest, callback) {
    let file = fs.createWriteStream(dest);
    request.get(url)
        .pipe(file)
        .on('error', function (err) {
            fs.unlink(dest);
            callback(err.message);
        });
    file.on('finish', function() {
        file.close(callback);
    });
}

function cleanup (id) {
    logger(id, 'info', 'Cleaning up...');
    delete ramdb[id];
    fs.removeSync(path.resolve(config.file_storage + '/' + id));
}

function loadLang () {
    for (let k in config.available_lang){
        if (config.available_lang.hasOwnProperty(k)) {
            messages[k] = JSON.parse(fs.readFileSync(path.resolve('./lang/' + k + '.json'), 'utf8'));
            logger('INTERNAL', 'info', 'Loaded language strings: ' + k);
        }
    }
}

function logger (chatId, type, msg) {
    console.log('[' + chatId + ']', '[' + type.toUpperCase() + ']', msg);
}
