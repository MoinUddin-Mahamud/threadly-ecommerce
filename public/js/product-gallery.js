// Product page: clicking a small picture shows it large. Without this script the small pictures
// are plain links to the full-size file.
document.addEventListener('click', function (event) {
  var link = event.target.closest ? event.target.closest('[data-gallery-thumb]') : null;
  var main = document.getElementById('productMainImage');
  if (!link || !main) return;
  event.preventDefault();
  main.src = link.getAttribute('href');
});
