using Microsoft.AspNetCore.Components.WebAssembly.Hosting;

var builder = WebAssemblyHostBuilder.CreateDefault(args);

// Add Telerik Blazor client side services
builder.Services.AddTelerikBlazor();

await builder.Build().RunAsync();

