package com.example.mod;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerWorldEvents;
import net.minecraft.item.Item;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.util.Identifier;

public class ExampleMod implements ModInitializer {
    public static final Item EXAMPLE_ITEM = new Item(new Item.Settings());

    @Override
    public void onInitialize() {
        Registry.register(Registries.ITEM, new Identifier("example-mod", "example_item"), EXAMPLE_ITEM);

        ServerWorldEvents.LOAD.register((ServerWorld world, MinecraftServer server) -> {
            System.out.println("World loaded");
        });
    }
}
