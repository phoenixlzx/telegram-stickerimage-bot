#!/bin/env node
'use strict';

var config = require('./config.js');

var fs = require('fs-extra');
var path = require('path');

var Telegraf = require('telegraf');
var commandParts = require('telegraf-command-parts');
var im = require('imagemagick');
var JSZip = require("jszip");
var async = require('async');
var http = require('http');

var token = config.token;
var bot = new Telegraf(token);

bot.use(commandParts);
im.convert.path = config.im_convert_path;

var messages = JSON.parse(fs.readFileSync(path.resolve('./lang/' + config.default_lang + '.json'), 'utf8'));

var ramdb = {};
// check storage path
var fspath = path.resolve(config.file_storage);
fs.stat(fspath, function(err, stats) {
    if (err && err.code === 'ENOENT') {
        console.log(messages.app.storagepathnotexist);
        fs.mkdirpSync(fspath);
    }
});

bot.catch(function (err) {
    console.log(err);
});

bot.command('lang', function (ctx) {
    i18nHandler(ctx);
});

bot.command('newpack', function (ctx) {
    newPackHandler(ctx);
});

bot.command('finish', function (ctx) {
    var chatId = msg.chat.id;
    if (ramdb[chatId] && ramdb[chatId].islocked) {
        return bot.sendMessage(chatId, messages.msg.tasklocked);
    }
    var r = new RegExp(/\s?(png)?\s?(\d+)?/i);
    var match = r.exec(ctx.state.command.args);
    var imopts = {
        format: match[1],
        width: parseInt(match[2])
    };
    if (ramdb[chatId] && ramdb[chatId].files.length > 0) {
        finishHandler(ctx, imopts);
    } else {
        ctx.telegram.sendMessage(chatId, messages.msg.nosticker);
    }
});

bot.command('cancel', function (ctx) {
    cancellationHandler(ctx);
});

bot.start(function (ctx) {
    return ctx.telegram.sendMessage(messages.msg.start);
});

bot.on('message', function (ctx) {
    generalMsgHandler(ctx);
});

bot.startPolling();

function errMsgHandler(ctx, err) {
    var chatId = ctx.message.chat.id;
    if (err) {
        ctx.telegram.sendMessage(chatId, messages.msg.errmsg
            .replace('%errcode%', err.code)
            .replace('%errbody%', err.response.body));
    } else {
        ctx.telegram.sendMessage(chatId, messages.msg.error);
    }
    return cleanup(chatId);
}
function newPackHandler (ctx) {
    var chatId = ctx.message.chat.id;
    if (ramdb[chatId] && ramdb[chatId].islocked) {
        return ctx.telegram.sendMessage(chatId, messages.msg.tasklocked);
    }
    if (ramdb[chatId] && ramdb[chatId].files.length > 0) {
        return ctx.telegram.sendMessage(chatId, messages.msg.taskexist);
    }
    ramdb[chatId] = {
        start: msg.date,
        files: [],
        srcimg: [],
        destimg: [],
        islocked: false
    };
    logger(chatId, 'info', 'Started a new pack task.');
    return ctx.telegram.sendMessage(chatId, messages.msg.newpack.replace('%max%', config.maximages));
}

function finishHandler (ctx, imopts) {
    var chatId = ctx.message.chat.id;
    logger(chatId, 'info', 'Starting pack task...');
    ramdb[chatId].islocked = true;
    var fpath = {
        packpath: config.file_storage + '/' + chatId
    };
    fpath['srcpath'] = packpath + '/src/';
    fpath['imgpath'] = packpath + '/img/';
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
            ctx.telegram.sendMessage(chatId, messages.msg.sending);
            ctx.telegram.sendDocument(chatId, res[2]);
            logger(chatId, 'info', 'Sending zip file...');
            cleanup(chatId);
            logger(chatId, 'info', 'Task finished.');
        }
    );
}

function cancellationHandler (ctx) {
    var chatId = ctx.message.chat.id;
    if (!ramdb[chatId]) {
        return ctx.telegram.sendMessage(chatId, messages.msg.notask);
    }
    delete ramdb[chatId];
    cleanup(chatId);
    logger(chatId, 'info', 'Task Cancelled.');
    return ctx.telegram.sendMessage(chatId, messages.msg.taskcancelled);
}

function generalMsgHandler (ctx) {
    var chatId = ctx.message.chat.id;
    if (ctx.chat.type !== 'private' && ctx.state.command.bot !== ctx.me) return; // do not reply to group or channels unless mentioned
    if (ctx.message.sticker && ramdb[chatId] && !ramdb[chatId].islocked) {
        if (ramdb[chatId].files.indexOf(ctx.message.sticker.file_id) !== -1) {
            return ctx.telegram.sendMessage(chatId, ctx.message.message_id, messages.msg.duplicated_sticker);
        }
        if (ramdb[chatId].files.length >= config.maximages) {
            return ctx.telegram.sendMessage(chatId, messages.msg.taskfull);
        }
        ramdb[chatId].files.push(ctx.message.sticker.file_id);
        var remain = config.maximages - ramdb[chatId].files.length;
        return ctx.telegram.sendMessage(chatId, remain === 0 ? messages.msg.taskfull : messages.msg.saved.replace('%remain%', remain));
    } else {
        if (['finish', 'newpack', 'cancel', 'lang', 'getset'].indexOf(ctx.state.command.command) === -1) {
            return ctx.telegram.sendMessage(chatId,
                (ramdb[chatId] && ramdb[chatId].islocked) ? messages.msg.tasklocked : messages.msg.start);
        }
    }
}

function i18nHandler (ctx) {
    var chatId = ctx.message.chat.id,
        chosen_lang = ctx.state.command.args.replace(/\s+/g, ''); // strip spaces
    if (config.available_lang.hasOwnProperty(chosen_lang)) {
        messages = JSON.parse(fs.readFileSync(path.resolve('./lang/' + chosen_lang + '.json'), 'utf8'));
        logger(chatId, 'info', 'Changing language to: ' + chosen_lang);
        return ctx.telegram.sendMessage(chatId, messages.msg.language_change)
    }
    var message = messages.msg.language_available,
        languages_names = '';
    for (var k in config.available_lang){
        if (config.available_lang.hasOwnProperty(k)) {
            languages_names += '\n' + '[' + k + '] ' + config.available_lang[k].join(' / ')
        }
    }
    return ctx.telegram.sendMessage(chatId, message.replace('%languages%', languages_names));
}

function downloadHanlder (ctx, fpath, callback) {
    var chatId = ctx.message.chat.id;
    logger(chatId, 'info', 'Downloading files...');
    ctx.telegram.sendMessage(chatId, messages.msg.downloading);
    async.each(ramdb[chatId].files, function (fileId, cb) {
        var url = bot.telegram.getFilelink(fileId);
        var srcimg = fpath.srcpath + path.basename(url);
        download(url, srcimg, function (err, srcimg) {
            if (err) {
                logger(chatId, 'error', 'Downloading file [' + fileId + '] from ' + url);
                return cb(err);
            }
            if (srcimg.indexOf('.') === -1) {
                var new_srcimg = srcimg + '.webp';
                fs.renameSync(srcimg, new_srcimg);
                srcimg = new_srcimg;
            }
            logger(chatId, 'info', 'File ' + fileId + ' saved to disk.');
            ramdb[chatId].srcimg.push(srcimg);
            cb();
        })
    }, function (err) {
        callback(err);
    });
}

function convertHandler (ctx, fpath, imopts, callback) {
    var chatId = ctx.message.chat.id;
    var width = imopts.width;
    var format = imopts.format;
    logger(chatId, 'info', 'Converting images...');
    ctx.telegram.sendMessage(chatId, messages.msg.converting);
    async.eachSeries(ramdb[chatId].srcimg, function (src, cb) {
        var imarg = [src];
        var destimg = path.resolve(fpath.imgpath + '/' + path.basename(src, 'webp') + 'jpg');
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
    var chatId = ctx.message.chat.id;
    ctx.telegram.sendMessage(chatId, messages.msg.packaging);
    logger(chatId, 'info', 'Adding files to ZIP file...');
    var zip = new JSZip();
    ramdb[chatId].srcimg.forEach(function (src) {
        var fname = chatId + '/src/' + path.basename(src);
        logger(chatId, 'info', 'Adding file ', fname);
        zip.file(fname, fs.readFileSync(path.resolve(src)));
    });
    ramdb[chatId].destimg.forEach(function (dest) {
        var fname = chatId + '/img/' + path.basename(dest);
        logger(chatId, 'info', 'Adding file ', fname);
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

function download (url, dest, callback) {
    var file = fs.createWriteStream(dest);
    var request = http.get(url, function (response) {
        response.pipe(file);
        file.on('finish', function() {
            file.close(callback);
        });
    }).on('error', function (err) {
        fs.unlink(dest);
        callback(err.message);
    });
}

function cleanup (id) {
    logger(id, 'info', 'Cleaning up...');
    delete ramdb[id];
    fs.removeSync(path.resolve(config.file_storage + '/' + id));
}

function logger (chatId, type, msg) {
    console.log('[' + chatId + ']', '[' + type.toUpperCase() + ']', msg);
}
