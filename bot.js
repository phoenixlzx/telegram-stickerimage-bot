#!/bin/env node
'use strict';

var config = require('./config.js');

var fs = require('fs-extra');
var path = require('path');

var TelegramBot = require('node-telegram-bot-api');
var im = require('imagemagick');
var AdmZip = require('adm-zip');
var async = require('async');

var token = config.token;
var bot = new TelegramBot(token, {polling: true});
im.convert.path = config.im_convert_path;

var messages = JSON.parse(fs.readFileSync(path.resolve('./lang/' + config.lang + '.json'), 'utf8'));

var ramdb = {};
// check storage path
var fspath = path.resolve(config.file_storage);
fs.stat(fspath, function(err, stats) {
    if (err && err.code === 'ENOENT') {
        console.log(messages.app.storagepathnotexist);
        fs.mkdirpSync(fspath);
    }
});

bot.onText(/\/newpack*/i, function (msg) {
    var chatId = msg.chat.id;
    ramdb[chatId] = {
        start: msg.date,
        files: [],
        srcimg: []
    };
    bot.sendMessage(chatId, messages.msg.newpack.replace('%max%', config.maximages));
});

bot.onText(/\/finish\s?(png)?\s?(\d+)?/i, function (msg, match) {
    var chatId = msg.chat.id;
    var format = match[1];
    var width = match[2];
    if (ramdb[chatId] && ramdb[chatId].files.length > 0) {
        console.log('[' + chatId + '] Starting pack task...');
        var packpath = config.file_storage + '/' + chatId,
            srcpath = packpath + '/src',
            imgpath = packpath + '/img';
        fs.mkdirpSync(path.resolve(packpath));
        fs.mkdirpSync(path.resolve(srcpath));
        fs.mkdirpSync(path.resolve(imgpath));
        async.series([
            function (cb) {
                console.log('[' + chatId + '] Downloading files...');
                bot.sendMessage(chatId, messages.msg.downloading);
                async.eachSeries(ramdb[chatId].files, function(fileId, callback) {
                    bot.downloadFile(fileId, path.resolve(srcpath))
                            .then(function (srcimg) {
                                console.log('[' + chatId + '] File ' + fileId + ' saved to disk.');
                                ramdb[chatId].srcimg.push(srcimg);
                                callback();
                            });
                    }, function(err) {
                        cb();
                    });
            },
            function (cb) {
                console.log('[' + chatId + '] Converting images...');
                bot.sendMessage(chatId, messages.msg.converting);
                async.eachSeries(ramdb[chatId].srcimg, function (src, callback) {
                    var imarg = [src];
                    if (width && width < 512) {
                        imarg.push('-resize', width + 'x' + width);
                    }
                    if (format === 'png') {
                        imarg.push(path.resolve(imgpath + '/' + path.basename(src, 'webp') + 'png'))
                    } else {
                        // use -flatten to add white background to jpg files
                        imarg.push('-flatten', path.resolve(imgpath + '/' + path.basename(src, 'webp') + 'jpg'))
                    }
                    console.log('[' + chatId + '] Convert command:', im.convert.path, imarg.join(' '));
                    im.convert(imarg, function (err, stdout) {
                        if (err) {
                            // ...
                        }
                        console.log(stdout);
                        callback(err);
                    });
                }, function (err) {
                    cb();
                });
            },
            function (cb) {
                bot.sendMessage(chatId, messages.msg.packaging);
                console.log('[' + chatId + '] Packaging files...');
                var zip = new AdmZip('pack.zip');
                zip.addLocalFolder(path.resolve(packpath));
                var packdata = zip.toBuffer();
                cb(null, packdata);
            }],
            function (err, res) {
                bot.sendMessage(chatId, messages.msg.sending);
                bot.sendDocument(chatId, res[2]);
                console.log('[' + chatId + '] Sending zip file...');
                // clear task
                fs.removeSync(path.resolve(packpath));
                ramdb[chatId] = undefined;
                console.log('[' + chatId + '] Task finished.');
            }
        );
    } else {
        bot.sendMessage(chatId, messages.msg.nosticker);
    }
});

bot.on('message', function (msg) {
    var chatId = msg.chat.id;

    if (msg.sticker && ramdb[chatId]) {
        ramdb[chatId].files.push(msg.sticker.file_id);
        bot.sendMessage(chatId, messages.msg.saved.replace('%remain%', config.maximages - ramdb[chatId].files.length));
    } else {
        if (!/(\/(finish|newpack))/i.exec(msg.text)) {
            bot.sendMessage(chatId, messages.msg.start);
        }
    }
});
