(function (path){
  "use strict";
  var zinnia = {};
  zinnia.Recognizer = function(){
    this.codes = [];
    this.bias;
    this.index = [];
    this.value = [];
  };
  
  zinnia.Recognizer.prototype.modelLoadFrom = function(path) {
    var self = this;
    var xhr = new XMLHttpRequest();
    xhr.open("GET", path, true);
    xhr.responseType = "arraybuffer";
    xhr.onload = function(){
      var arrayBuffer = xhr.response;
      var view = new DataView(arrayBuffer);
      var little_endian = (new Int8Array(new Int32Array([1]).buffer)[0] === 1);
      var modelCount = view.getUint32(8,little_endian);
      self.bias = new Float32Array(modelCount);
      var fcc = String.fromCharCode;
      
      //ignore to parse magic, version
      var offset = 12;
      for(var i = 0 ; i !== modelCount ; ++i) {
        //code
        var raw = new Uint8Array(arrayBuffer, offset, 16);
        if (raw[0] < 128){
          self.codes.push(fcc(raw[0]));
        } else if (raw[0] > 191 && raw[0] < 224) {
          self.codes.push(fcc(((raw[0] & 31) << 6) | ( raw[1] & 63)));
        } else {
          self.codes.push(fcc(((raw[0] & 15) << 12) | (( raw[1] & 63) << 6) | ( raw[2] & 63)));
        }
          offset += 16;
          
        //bias
        self.bias[i] = view.getFloat32(offset,little_endian);
          offset += 4;
          
        var index = [];
        var value = [];
        while (true) {
          index.push(view.getUint32(offset,little_endian));
            offset += 4;
          value.push(view.getFloat32(offset,little_endian));
            offset += 4;
          if (index[index.length-1] === 0xFFFFFFFF) {
            index.pop();
            break;
          }
        }
        self.index.push(new Uint32Array(index));
        self.value.push(new Float32Array(value));
      }
      document.getElementById("loader").remove();
    };
    xhr.send();
  };
  
  zinnia.Recognizer.prototype.classify = function(character, nbest) {
    var features = this.characterToFeatures(character);
    var results = [];
    
    function featureDot(index, value, x2) {
      var i = 0, j = 0, sum = 0;
      while (i < index.length && j < x2.length) {
        var b = x2[j];
        if (index[i] === b.index) {
          sum += value[i] * b.value;
          ++i;
          ++j;
        } else if (index[i] < b.index) {
          ++i;
        } else {
          ++j;
        }
      }
      return sum;
    }
    
    var self = this;
    this.codes.forEach(function(code, i){
      results.push({
        bias: self.bias[i] + featureDot(self.index[i], self.value[i], features),
        code: code
      });
    });
    
    function insert(maxlist, item){
      for(var i = 0; item.bias < maxlist[i].bias; i++){}
      maxlist.splice(i,0,item);
      maxlist.pop();
    }
    
    function partialSort(arr,n){
      var maxlist = arr.slice(arr,n).sort(function(a,b){return b.bias-a.bias;});
      for(var i = n, len = arr.length ; i!=len ; i++){
        if (arr[i].bias > maxlist[n-1].bias) {
          insert(maxlist, arr[i]);
        }
      }
      return maxlist;
    }
    return partialSort(results, nbest);
  };
  
  zinnia.Recognizer.prototype.characterToFeatures = function(character) {
    
    var strokeOffsets = character.strokeOffsets;
    var strokes = strokeOffsets.length - 1;
    var nodes = character.nodes;
    if (nodes.length <= 0) throw new Error("Invalid character");
    var features = [{index: 0, value: 1}];  // First Bias term
    
    function addFeature(index, value) {
      features.push({
        index: index,
        value: value
      });
    }
    
    // void Features::makeBasicFeature(int offset, const Node *first, const Node *last)
    function makeBasicFeature(offset, firstX, firstY, lastX, lastY) {
      function distance(x1, y1, x2, y2) {
        var dx = x1 - x2;
        var dy = y1 - y2;
        return Math.sqrt(dx * dx + dy * dy);
      }      
      
      // distance
      addFeature(offset + 1 , 10 * distance(firstX, firstY, lastX, lastY));
      
      // degree
      addFeature(offset + 2, Math.atan2(lastY - firstY, lastX - firstX));
      
      // absolute position
      addFeature(offset + 3, 10 * (firstX - 0.5));
      addFeature(offset + 4, 10 * (firstY - 0.5));
      addFeature(offset + 5, 10 * (lastX - 0.5));
      addFeature(offset + 6, 10 * (lastY - 0.5));
      
      // absolute degree
      addFeature(offset + 7, Math.atan2(firstY - 0.5, firstX - 0.5));
      addFeature(offset + 8, Math.atan2(lastY - 0.5,  lastX - 0.5));
      
      // absolute distance
      addFeature(offset + 9,  10 * distance(firstX, firstY, 0.5, 0.5));
      addFeature(offset + 10, 10 * distance(lastX, lastY, 0.5, 0.5));
      
      // diff
      addFeature(offset + 11, 5 * (lastX - firstX));
      addFeature(offset + 12, 5 * (lastY - firstY));
    }
    
    // void Features::makeVertexFeature(int sid, std::vector<NodePair> *node_pairs)
    function makeVertexFeature(nodes, sid, nodePairs) { 
      for (var i = 0, len = nodePairs.length ; i != len && i != 50; ++i) { //i < MAX_CHARACTER_SIZE
        var n = nodePairs[i];
        if (n) {
          makeBasicFeature( sid*1000 + 20*i, nodes[n.firstI], nodes[n.firstI + 1], nodes[n.lastI], nodes[n.lastI + 1] );
        }
      }
    }

    function getVertex(nodes, firstI, lastI, id, pairs) {
      pairs[id] = { firstI: firstI, lastI: lastI };
      
      if (firstI !== lastI) {
        var a = nodes[lastI] - nodes[firstI];
        var b = nodes[lastI + 1] - nodes[firstI + 1];
        var c = nodes[lastI + 1] * nodes[firstI] - nodes[lastI] * nodes[firstI + 1];
        
        var max = -1;
        var bestI = null;
        for (var curI = firstI; curI !== lastI; curI += 2) {
          var dist = Math.abs( a*nodes[curI + 1] - b*nodes[curI] + c );
          if (dist > max) {
            max = dist;
            bestI = curI;
          }
        }
        if (max * max / (a * a + b * b) > 0.001) { //minimumDistance > ERROR
          getVertex(nodes, firstI, bestI, id * 2 + 1, pairs);
          getVertex(nodes, bestI, lastI, id * 2 + 2, pairs);
        }
      }
    }
    
    var prevI;
    for (var i = 0; i != strokes; ++i) {
      var firstI = strokeOffsets[i];
      var lastI = strokeOffsets[i + 1] - 2;
      var nodePairs = [];
      getVertex(nodes, firstI, lastI, 0, nodePairs);
      makeVertexFeature(nodes, i, nodePairs);
      if (i > 0) {
        makeBasicFeature(100000 + i * 1000, nodes[prevI], nodes[prevI + 1], nodes[firstI], nodes[firstI + 1]);
      }
      prevI = lastI;
    }
    addFeature(2000000, strokes);
    addFeature(2000000 + strokes, 10);
    features.sort(function (a, b) {return a.index - b.index;});
    return features;
  };

  var recognizer = new zinnia.Recognizer();
  recognizer.modelLoadFrom(path);
  var width = 400, height = 400;
  var canvas = document.getElementById('canvas');
  canvas.setAttribute('width', width);
  canvas.setAttribute('height',height);
  var ctx = canvas.getContext('2d');
  ctx.strokeStyle = "white";
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.shadowBlur = 10;
  ctx.globalAlpha = 0.7;
  ctx.shadowColor= "#CCCCCC";
  
  var last;
  var strokeOffsets = [0];
  var nodes = [];
  var click = false; 
  
  function render(cur){
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(cur.x, cur.y);
    ctx.stroke();
    ctx.closePath();
  }
  
  function down(cur){
    click = true;
    nodes.push(cur.x/width, cur.y/height);
    last = cur;
  }
  
  function move(cur){
    if (click){
      render(cur);
      nodes.push(cur.x/width, cur.y/height);
      last = cur;
    }
  }
  
  function up(cur) {
    render(cur);
    nodes.push(cur.x/width, cur.y/height);
    strokeOffsets.push(nodes.length);
    click = false;
    recommend();
  }
  
  function recommend(){
    document.getElementById('suggestions').innerHTML = '';
    recognizer.classify({ nodes:nodes, strokeOffsets:strokeOffsets}, 8).forEach(function(item){
      var sug = document.createElement('span');
      sug.addEventListener('click', function(e){
        document.getElementById('wordsOut').value += this.innerHTML;
        clear();
      }, false);
      sug.innerHTML = item.code;
      sug.setAttribute('class', 'sugItem');
      document.getElementById('suggestions').appendChild(sug);
    });	  
  }
  
  function findxy(res, e){
    if (res === 'downE') down({x:(e.clientX - canvas.offsetLeft), y:(e.clientY - canvas.offsetTop)});
    if (res === 'moveE') move({x:(e.clientX - canvas.offsetLeft), y:(e.clientY - canvas.offsetTop)});
    if (res === 'upE'  )   up({x:(e.clientX - canvas.offsetLeft), y:(e.clientY - canvas.offsetTop)});
  }
  canvas.addEventListener('mousedown', function(e){ findxy('downE',e);}, false);
  canvas.addEventListener('mousemove', function(e){ findxy('moveE',e);}, false);
  canvas.addEventListener('mouseup',   function(e){ findxy('upE',  e);}, false);
  canvas.addEventListener('mouseout',  function(e){ click = false;   }, false);
  canvas.addEventListener('touchstart',function(e){ findxy('downE',e.targetTouches[0]);}, false);
  canvas.addEventListener('touchmove', function(e){ findxy('moveE',e.targetTouches[0]);}, false);
  canvas.addEventListener('touchend',  function(e){ findxy('upE',  e.changedTouches[0]);},false);
  canvas.addEventListener('touchleave',function(e){ click = false;},false);
  function clear(){
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    strokeOffsets = [0];
    nodes = [];
  }
  document.getElementById('clear').addEventListener('click', clear);
  document.getElementById('back' ).addEventListener('click', back);
  
  function back(){
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if(strokeOffsets[1]){
      strokeOffsets.pop();
      nodes.length = strokeOffsets[strokeOffsets.length-1];
      for(var i=0 ;strokeOffsets[i+1]; i++){
        last = {x:nodes[strokeOffsets[i]]*width,y:nodes[strokeOffsets[i]+1]*height};
        for(var j = strokeOffsets[i]+2; j!= strokeOffsets[i+1]; j+= 2){
          render({x:nodes[j]*width,y:nodes[j+1]*height});
          last = {x:nodes[j]*width,y:nodes[j+1]*height};
        }
      }
      recommend();     
    }
  }
})('handwriting-zh_TW.model');
