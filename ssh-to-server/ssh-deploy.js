/**
 * Created by Zhangyu on 2018/3/14.
 */
var ssh2 = require("ssh2");
var through = require('through');
var fs = require("fs");
var path = require('path');
var util = require("util")
var events = require("events");
var config = require("../config/publish");

//初始化连接客户端实例
var Client = ssh2.Client;
//构造函数
function ssh2Tools() {
	this.conn = new Client();
}

ssh2Tools.prototype = {
	/**
	 * 创建连接
	 * @param server - 远程linux服务器配置信息
	 * @param callback - 连接成功后的回调函数
	 */
	connect: function (server, callback) {
		this.conn.on("ready", function () {
			//连接就绪
			console.log("连接服务器" + server["host"] + "成功，准备就绪....");
			//触发回调
			if (callback)callback();
		}).on("error", function (err) {
			console.log("ssh 连接异常：", err);
		}).on("close", function (msg) {
			console.log("ssh 连接关闭：", msg);
		}).connect(server);
	},
	/**
	 * 关闭连接
	 * @param callback - 连接关闭后的回调函数
	 */
	disConnect: function (callback) {
		//触发回调
		if (callback) callback();
		//触发关闭
		this.conn.end();
	},
	/**
	 * 执行远程linux命令
	 * @param cmd - 命令正文
	 * @param callback - 回调函数
	 */
	exec: function (cmd, callback) {
		this.conn.exec(cmd, function (err, stream) {
			var data = "";
			stream.pipe(through(function onWrite(buf) {
				data = data + buf;
			}, function onEnd() {
				stream.unpipe();
			}));
			stream.on("close", function () {
				console.log("执行命令：", cmd);
				//触发回调
				if (callback) callback(null, "" + data);
			});
		});
	},
	/**
	 * 上传文件到服务器
	 * @param localPath - 本地文件路径
	 * @param remotePath - 远程文件路径
	 * @param callback - 回调函数
	 */
	uploadFile: function (localPath, remotePath, callback) {
		this.conn.sftp(function (err, sftp) {
			if(err){
				callback(err);
			} else {
				sftp.fastPut(localPath, remotePath, function (err, result) {
					sftp.end();
					callback(err, result);
				});
			}
		});
	},
	/**
	 * 上传本地文件夹到远程linux服务器
	 * @param localDir - 本地文件路径
	 * @param remoteDir - 远程文件路径
	 * @param callback - 回调函数
	 */
	uploadDir: function (localDir, remoteDir, callback) {
		var self = this, dirs = [], files = [];
		//获取本地待上传的目录及文件列表
		getFileAndDirList(localDir, dirs, files);
		this.totalFilesCount = files.length;
		//创建远程目录
		var rDirsCmd = [], dirCmdFileName = "tmp_" + (new Date()).getTime() + ".sh";
		var fsCmdFile = fs.createWriteStream(dirCmdFileName);
		//遍历目录，形成命令文件
		dirs.forEach(function (dir) {
			var to = path.join(remoteDir, dir.substring(localDir.length - 1)).replace(/[\\]/g, "/");
			var cmd = "mkdir -p " + to + "\n";
			rDirsCmd.push(cmd);
			fs.appendFileSync(dirCmdFileName, cmd, "utf8");
		});
		fsCmdFile.end();

		//遍历文件列表，形成执行函数数组
		var rFileCmdArr = [];
		files.forEach(function (file) {
			rFileCmdArr.push(function (done) {
				var to = path.join(remoteDir, file.substring(localDir.length - 1)).replace(/[\\]/g, '/');
				console.log("upload " + file + " to " + to);
				self.uploadFile(file, to, function (err, result) {
					done(err, result);
				});
			});
		});
		//创建根目录
		this.exec("mkdir -p " + remoteDir + " \n exit \n", function (err, data) {
			console.log("在服务器上创建根目录成功。");
			if (err) {
				callback(err);
				return;
			}
			//开始上传子目录的命令文件
			self.uploadFile(dirCmdFileName, remoteDir + "/" + dirCmdFileName, function (err, result) {
				//删除本地的命令文件
				fs.unlinkSync(dirCmdFileName);
				if (err) throw err;
				console.log("上传目录命令文件成功。");
				//开始执行上传
				self.exec("cd " + remoteDir + "\n sh " + dirCmdFileName + "\n rm -rf " + dirCmdFileName + "\n exit \n", function (err, data) {
					if (err) throw err;
					console.log("创建目录结构成功。");
					console.log("开始上传文件...");
					control.emit("donext", rFileCmdArr, function (err) {
						if (err) throw err;
						if (callback) callback();
					});
				});
			});
		});
	}
};

function Control () {
	events.EventEmitter.call(this);
}

util.inherits(Control, events.EventEmitter);

var control = new Control();

control.on("donext", function (arr, callback) {
	if(arr.length > 0) {
		var func = arr.shift();
		func(function (err, result) {
			if(err) {
				callback(err);
				return;
			}
			control.emit("donext", arr, callback);
		});
	} else {
		callback(null);
	}
});


/**
 * 获取windows上的文件目录以及文件列表信息
 * @param localDir - 本地路径
 * @param dirs - 目录列表
 * @param files - 文件列表
 */
function getFileAndDirList(localDir, dirs, files) {
	var dir = fs.readdirSync(localDir);
	for (var i = 0; i < dir.length; i++) {
		var p = path.join(localDir, dir[i]);
		var stat = fs.statSync(p);
		if(stat.isDirectory()){
			dirs.push(p);
			getFileAndDirList(p, dirs, files);
		} else {
			files.push(p);
		}
	}
}
//时间格式化函数
function getTimeSlot() {
	var date = new Date(),
		year = date.getFullYear(),
		month = date.getMonth() + 1,
		day = date.getDate(),
		hour = date.getHours(),
		minute = date.getMinutes(),
		second = date.getSeconds();
	return year + '-' + month + '-' + day + '-' + hour + ':' + minute + ':' + second;
};
/**
 * 发布启动逻辑
 */
var startPublish = function (isPva) {
	//创建实例
	var PublishExpress = new ssh2Tools();
	console.log("开始发布流程...");
	//创建连接
	PublishExpress.connect(config.server, function () {
		var remotePath = isPva ? config.remotePvaPath : config.remotePath,
			localPath = isPva ? "../pva" : "./dist";
		//备份已有的文件
		console.log("开始备份已有的" + localPath + "目录...");
		PublishExpress.exec("mv "+remotePath+" "+ remotePath +"-" + getTimeSlot() +" \nexit\n", function (msg1, msg2) {
			console.log("备份成功.");
			console.log("开始上传本地包文件...");
			//开始上传本地文件
			PublishExpress.uploadDir(localPath, remotePath, function (err) {
				if(err) {
					console.log("\n\n发布失败！！", err);
				} else {
					console.log("\n\n发布完成！！");
				}
			});
		});
	});
};

//标记直接运行的npm run publish
// npm run publish pva 或 npm run publishPva 远程部署pva
if(process.argv.length >= 4) {
	//触发发布
	var isPvaCode = false;
	if(process.argv[4] && process.argv[4] === 'pva') {
		isPvaCode = true;
	}
	startPublish(isPvaCode);
}
//对外暴露
module.exports = startPublish;

