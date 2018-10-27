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
let langSession = {};

bot.use(function (ctx, next) {
    if (ctx.message && !langSession[ctx.message.chat.id]) {
        langSession[ctx.message.chat.id] = config.default_lang;
    }
    return next();
});

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
    let chatId = ctx.message.chat.id;
    if (ramdb[chatId] && ramdb[chatId].islocked) {
        return ctx.reply(messages[langSession[chatId]].msg.tasklocked);
    }
    if (ramdb[chatId] && ramdb[chatId].files.length > 0) {
        return ctx.reply(messages[langSession[chatId]].msg.taskexist);
    }
    newPackHandler(ctx, function (err) {
        return ctx.reply(messages[langSession[chatId]].msg.newpack.replace('%max%', config.maximages));
    });
});

bot.command('finish', function (ctx) {
    let chatId = ctx.message.chat.id;
    if (ramdb[chatId] && ramdb[chatId].islocked) {
        return ctx.reply(messages[langSession[chatId]].msg.tasklocked);
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
        ctx.reply(messages[langSession[chatId]].msg.nosticker);
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
        ctx.reply(messages[langSession[chatId]].msg.errmsg
            .replace('%errcode%', err.code)
            .replace('%errbody%', err.response.body));
    } else {
        ctx.reply(messages[langSession[chatId]].msg.error);
    }
    return cleanup(chatId);
}

function newPackHandler (ctx, callback) {
    let chatId = ctx.message.chat.id;
    logger(chatId, 'info', 'Started a new pack task.');
    ramdb[chatId] = {
        start: ctx.message.date,
        files: [],
        srcimg: [],
        destimg: [],
        islocked: false
    };
    callback();
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
                ctx.reply(messages[langSession[chatId]].msg.downloading);
                downloadHanlder(ctx, fpath, function (err) {
                    cb(err);
                });
            },
            function (cb) {
                ctx.reply(messages[langSession[chatId]].msg.converting);
                convertHandler(ctx, fpath, imopts, function (err) {
                    cb(err);
                })
            },
            function (cb) {
                ctx.reply(messages[langSession[chatId]].msg.packaging);
                zipHandler(ctx, function (err, zip) {
                    cb(err, zip);
                });
            }],
        function (err, res) {
            if (err) {
                errMsgHandler(ctx, err);
            }
            ctx.reply(messages[langSession[chatId]].msg.sending);
            logger(chatId, 'info', 'Sending zip file...');
            ctx.telegram.sendDocument(ctx.from.id, {
                source: res[2],
                filename: 'stickers_' + chatId + '.zip'
            })
                .then(function () {
                    cleanup(chatId);
                    logger(chatId, 'info', 'Task finished.');
                })
                .catch(function(err){ errMsgHandler(ctx, err) });
        }
    );
}

function cancellationHandler (ctx) {
    let chatId = ctx.message.chat.id;
    if (!ramdb[chatId]) {
        return ctx.reply(messages[langSession[chatId]].msg.notask);
    }
    delete ramdb[chatId];
    cleanup(chatId);
    logger(chatId, 'info', 'Task Cancelled.');
    return ctx.reply(messages[langSession[chatId]].msg.taskcancelled);
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
                    if ((url.startsWith('https://t.me/addstickers/') || url.startsWith('https://telegram.me/addstickers/')) &&
                        url.length > 25) {
                        stickerSetHandler(ctx, path.basename(url));
                    }
                }
            });
        }
    } else if (!ramdb[chatId] && ctx.message.sticker) {
        directHandler(ctx);
    } else {
        ctx.reply((ramdb[chatId] && ramdb[chatId].islocked) ?
            messages[langSession[chatId]].msg.tasklocked :
            messages[langSession[chatId]].msg.start);
    }
}

function i18nHandler (ctx) {
    let chatId = ctx.message.chat.id,
        chosen_lang = ctx.state.command.args.replace(/\s+/g, ''); // strip spaces
    if (config.available_lang.hasOwnProperty(chosen_lang)) {
        langSession[ctx.message.chat.id] = chosen_lang;
        logger(chatId, 'info', 'Changing language to: ' + chosen_lang);
        return ctx.reply(messages[langSession[chatId]].msg.language_change)
    }
    let message = messages[langSession[chatId]].msg.language_available,
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
    async.eachSeries(ramdb[chatId].files, function (fileId, cb) {
        resolveFile(ctx, fileId, null, function (err, url) {
            if (url) {
                let destFile = fpath.srcpath + path.basename(url);
                download(ctx, url, destFile, function (err) {
                    if (err) return cb();
                    if (destFile && destFile.indexOf('.') === -1) {
                        let new_dest = destFile + '.webp';
                        fs.renameSync(destFile, new_dest);
                        destFile = new_dest;
                    }
                    logger(chatId, 'info', 'File ' + fileId + ' saved to disk.');
                    ramdb[chatId].srcimg.push(destFile);
                    cb();
                });
            } else {
                cb(); // skip link error files
            }
        })
    }, function (err) {
        callback(err);
    });
}

function convertHandler (ctx, fpath, imopts, callback) {
    let chatId = ctx.message.chat.id;
    logger(chatId, 'info', 'Converting images...');
    async.eachSeries(ramdb[chatId].srcimg, function (src, cb) {
        convert(ctx, src, fpath, {
            'width': imopts.width,
            'format': imopts.format
        }, function (err, dest) {
            ramdb[chatId].destimg.push(dest);
            cb(err);
        });
    }, function(err) {
        callback(err);
    });
}

function zipHandler (ctx, callback) {
    let chatId = ctx.message.chat.id;
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
    ctx.reply(messages[langSession[chatId]].msg.get_set_info);
    bot.telegram.getStickerSet(setName)
        .then(function (set) {
            if (ramdb[chatId].files.length + set.stickers.length >= config.maximages) {
                return ctx.reply(messages[langSession[chatId]].msg.taskfull);
            }
            logger(chatId, 'info', 'Adding Sticker Set: ' + setName);
            addSet(ctx, set);
        })
        .catch(function (err) {
            logger(chatId, 'error', 'Error Adding Sticker Set: ' + setName + ': ' + err);
            ctx.reply(messages[langSession[chatId]].msg.invalid_set.replace('%setName%', setName));
        });
}

function directHandler (ctx) {
    let chatId = ctx.message.chat.id;
    let messageId = ctx.message.message_id;
    newPackHandler(ctx, function () {
        ramdb[chatId].islocked = true;
        let fpath = {
            packpath: config.file_storage + '/' + chatId
        };
        fpath['srcpath'] = fpath.packpath + '/src/';
        fpath['imgpath'] = fpath.packpath + '/img/';
        fs.mkdirpSync(path.resolve(fpath.packpath));
        fs.mkdirpSync(path.resolve(fpath.srcpath));
        fs.mkdirpSync(path.resolve(fpath.imgpath));
        logger(chatId, 'info', 'Started direct image task.');
        ctx.reply(messages[langSession[chatId]].msg.direct_task_started)
            .then(function (pendingMsg) {
                resolveFile(ctx, ctx.message.sticker.file_id, messageId, function (err, url) {
                    if (err) {
                        return cleanup(chatId);
                    }
                    let destFile = fpath.srcpath + path.basename(url);
                    download(ctx, url, destFile, function (err) {
                        if (err) {
                            cleanup(chatId);
                            return ctx.reply(
                                messages[langSession[chatId]].msg.download_error,
                                Extra.inReplyTo(messageId)
                            );
                        }
                        convert(ctx, destFile, fpath, {format: 'png'}, function (err, png) {
                            if (err) {
                                cleanup(chatId);
                                return ctx.reply(
                                    messages[langSession[chatId]].msg.convert_error,
                                    Extra.inReplyTo(messageId)
                                );
                            }
                            ctx.replyWithDocument({
                                source: fs.readFileSync(png),
                                filename: path.basename(png)
                            }, Extra.inReplyTo(messageId))
                                .then(function () {
                                    ctx.deleteMessage(pendingMsg.message_id);
                                    cleanup(chatId);
                                });
                        });
                    });
                });
            });
    });
}

function addSticker(ctx) {
    let chatId = ctx.message.chat.id;
    if (ramdb[chatId].files.indexOf(ctx.message.sticker.file_id) !== -1) {
        return ctx.reply(messages[langSession[chatId]].msg.duplicated_sticker, Extra.inReplyTo(ctx.message.message_id));
    }
    if (ramdb[chatId].files.length >= config.maximages) {
        return ctx.reply(messages[langSession[chatId]].msg.taskfull);
    }
    ramdb[chatId].files.push(ctx.message.sticker.file_id);
    let remain = config.maximages - ramdb[chatId].files.length;
    ctx.reply(remain === 0 ?
        messages[langSession[chatId]].msg.taskfull :
        messages[langSession[chatId]].msg.saved.replace('%remain%', remain));
}

function addSet (ctx, set) {
    let chatId = ctx.message.chat.id;
    let originCount = ramdb[chatId].files.length;
    set.stickers.forEach(function (s) {
        if (ramdb[chatId].files.indexOf(s.file_id) === -1) {
            ramdb[chatId].files.push(s.file_id);
        }
    });
    ctx.reply(messages[langSession[chatId]].msg.set_added_count
        .replace('%sticker_count%', ramdb[chatId].files.length - originCount));
}

function resolveFile (ctx, fileId, inReplyTo, callback) {
    let chatId = ctx.message.chat.id;
    bot.telegram.getFileLink(fileId)
        .then(function(url) {
            callback(null, url);
        })
        .catch(function (err) {
            ctx.reply(
                messages[langSession[chatId]].msg.err_get_filelink.replace('%fileId%', fileId),
                inReplyTo ? Extra.inReplyTo(inReplyTo) : null);
            logger(chatId, 'error', 'Get File Link for ' + fileId + ': ' + err);
            callback(err, null);
        }); // no more finally(...)
}

function download (ctx, url, dest, callback) {
    let chatId = ctx.message.chat.id;
    let file = fs.createWriteStream(dest);
    request.get(url)
        .pipe(file)
        .on('error', function (err) {
            // Skip download error files #TODO notify user?
            logger(chatId, 'error', 'Downloading file [' + fileId + '] from ' + url);
            fs.unlink(dest);
            callback(err);
        });
    file.on('finish', function() {
        file.close(callback);
    });
}

function convert (ctx, src, fpath, opts, callback) {
    let chatId = ctx.message.chat.id;
    let imarg = [src];
    let width = opts['width'];
    let format = opts['format'];
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
    im.convert(imarg, function (err) {
        callback(err, destimg);
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
