#!/bin/env node
'use strict';

var config = require('./config.js');

var fs = require('fs-extra');
var path = require('path');

var TelegramBot = require('node-telegram-bot-api');
var im = require('imagemagick');
var JSZip = require("jszip");
var async = require('async');

var token = config.token;
var bot = new TelegramBot(token, {polling: true});
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

bot.onText(/\/lang\s?(\w{2})?/i, function (msg, match) {
    var chatId = msg.chat.id,
        chosen_lang = match[1];

    if (config.available_lang.hasOwnProperty(chosen_lang)) {
        messages = JSON.parse(fs.readFileSync(path.resolve('./lang/' + chosen_lang + '.json'), 'utf8'));
        return bot.sendMessage(chatId, messages.msg.language_change)
    }
    var message = messages.msg.language_available,
        languages_names = '';
    for (var k in config.available_lang){
        if (config.available_lang.hasOwnProperty(k)) {
            languages_names += '\n' + '[' + k + '] ' + config.available_lang[k].join(' / ')
        }
    }
    return bot.sendMessage(chatId, message .replace('%languages%', languages_names));
});

bot.onText(/\/newpack*/i, function (msg) {
    var chatId = msg.chat.id;
    if (ramdb[chatId] && ramdb[chatId].islocked) {
        return bot.sendMessage(chatId, messages.msg.tasklocked);
    }
    if (ramdb[chatId] && ramdb[chatId].files.length > 0) {
        return bot.sendMessage(chatId, messages.msg.taskexist);
    }
    ramdb[chatId] = {
        start: msg.date,
        files: [],
        srcimg: [],
        destimg: [],
        islocked: false
    };
    bot.sendMessage(chatId, messages.msg.newpack.replace('%max%', config.maximages));
});

bot.onText(/\/finish\s?(png)?\s?(\d+)?/i, function (msg, match) {
    var chatId = msg.chat.id;
    if (ramdb[chatId] && ramdb[chatId].islocked) {
        return bot.sendMessage(chatId, messages.msg.tasklocked);
    }
    var format = match[1];
    var width = match[2];
    if (ramdb[chatId] && ramdb[chatId].files.length > 0) {
        console.log('[' + chatId + '] Starting pack task...');
        ramdb[chatId].islocked = true;
        var packpath = config.file_storage + '/' + chatId,
            srcpath = packpath + '/src/',
            imgpath = packpath + '/img/';
        fs.mkdirpSync(path.resolve(packpath));
        fs.mkdirpSync(path.resolve(srcpath));
        fs.mkdirpSync(path.resolve(imgpath));
        async.series([
            function (cb) {
                console.log('[' + chatId + '] Downloading files...');
                bot.sendMessage(chatId, messages.msg.downloading);
                async.each(ramdb[chatId].files, function (fileId, callback) {
                    bot.downloadFile(fileId, path.resolve(srcpath))
                        .catch(function (err) {
                            console.error('[' + chatId + '] ERROR', err.code, err.response.body);
                            callback(err);
                        })
                        .then(function (srcimg) {
                            if (srcimg.indexOf('.') === -1) {
                                var new_srcimg = srcimg + '.webp';
                                fs.renameSync(srcimg, new_srcimg);
                                srcimg = new_srcimg;
                            }
                            console.log('[' + chatId + '] File ' + fileId + ' saved to disk.');
                            ramdb[chatId].srcimg.push(srcimg);
                            callback();
                        });
                    }, function (err) {
                        if (err) {
                            bot.sendMessage(chatId, messages.msg.errmsg
                                .replace('%errcode%', err.code)
                                .replace('%errbody%', err.response.body));
                        }
                        cb();
                    });
            },
            function (cb) {
                console.log('[' + chatId + '] Converting images...');
                bot.sendMessage(chatId, messages.msg.converting);
                async.eachSeries(ramdb[chatId].srcimg, function (src, callback) {
                    var imarg = [src];
                    var destimg = path.resolve(imgpath + '/' + path.basename(src, 'webp') + 'jpg');
                    if (width && width < 512) {
                        imarg.push('-resize', width + 'x' + width);
                    }
                    if (format === 'png') {
                        destimg = path.resolve(imgpath + '/' + path.basename(src, 'webp') + 'png');
                        imarg.push(destimg);
                    } else {
                        // use -flatten to add white background to jpg files
                        imarg.push('-flatten', destimg)
                    }
                    console.log('[' + chatId + '] Convert command:', im.convert.path, imarg.join(' '));
                    im.convert(imarg, function (err, stdout) {
                        ramdb[chatId].destimg.push(destimg);
                        callback(err);
                    });
                }, function (err) {
                    if (err) {
                        bot.sendMessage(chatId, messages.msg.error);
                        return cleanup(chatId);
                    }
                    cb();
                });
            },
            function (cb) {
                bot.sendMessage(chatId, messages.msg.packaging);
                console.log('[' + chatId + '] Adding files to package...');
                var zip = new JSZip();
                ramdb[chatId].srcimg.forEach(function (src) {
                    var fname = chatId + '/src/' + path.basename(src);
                    console.log('[' + chatId + '] Adding file ', fname);
                    zip.file(fname, fs.readFileSync(path.resolve(src)));
                });
                ramdb[chatId].destimg.forEach(function (dest) {
                    var fname = chatId + '/img/' + path.basename(dest);
                    console.log('[' + chatId + '] Adding file ', fname);
                    zip.file(fname, fs.readFileSync(path.resolve(dest)));
                });
                console.log('[' + chatId + '] Packaging files...');
                zip.generateAsync({
                    compression: 'DEFLATE',
                    type: 'nodebuffer',
                    comment: 'Created by stickerimagebot',
                    platform: process.platform
                })
                    .then(function (content) {
                        cb(null, content);
                    });
            }],
            function (err, res) {
                bot.sendMessage(chatId, messages.msg.sending);
                bot.sendDocument(chatId, res[2]);
                console.log('[' + chatId + '] Sending zip file...');
                // clear task
                cleanup(chatId);
                console.log('[' + chatId + '] Task finished.');
            }
        );
    } else {
        bot.sendMessage(chatId, messages.msg.nosticker);
    }
});

bot.onText(/\/cancel*/i, function (msg) {
    var chatId = msg.chat.id;
    if (!ramdb[chatId]) {
		return bot.sendMessage(chatId, messages.msg.notask);
    }
    delete ramdb[chatId];
    bot.sendMessage(chatId, messages.msg.taskcancelled);
});

bot.on('message', function (msg) {
    var chatId = msg.chat.id;

    if (msg.sticker && ramdb[chatId] && !ramdb[chatId].islocked) {
        if (ramdb[chatId].files.indexOf(msg.sticker.file_id) !== -1) {
            return bot.sendMessage(chatId, messages.msg.duplicated_sticker);
        }
        if (ramdb[chatId].files.length >= config.maximages) {
            return bot.sendMessage(chatId, messages.msg.taskfull);
        }
        ramdb[chatId].files.push(msg.sticker.file_id);
        var remain = config.maximages - ramdb[chatId].files.length;
        bot.sendMessage(chatId, remain === 0 ? messages.msg.taskfull : messages.msg.saved.replace('%remain%', remain));
    } else {
        if (!/(\/(finish|newpack|cancel|lang))/i.exec(msg.text)) {
            if (ramdb[chatId] && ramdb[chatId].islocked) {
                return bot.sendMessage(chatId, messages.msg.tasklocked);
            }
            bot.sendMessage(chatId, messages.msg.start);
        }
    }
});

function cleanup(id) {
    console.log('[' + id + '] Cleaning up...');
    delete ramdb[id];
    fs.removeSync(path.resolve(config.file_storage + '/' + id));
}

